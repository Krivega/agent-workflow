import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { preflightSubstantialTask } from '../src/activities/substantialTask.js';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import type { PayloadReaderCommand } from '../src/contracts/readerControl.js';
import { localPlanningRisks } from '../src/policy/localPlanning.js';
import { readH04Pin, type H04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  beginH06NativeAttempt,
  openH06NativeAttemptTurnLedger,
  planH06NativeAttempt,
} from './comparisonH06NativeAttempt.js';
import type { h06NativeTemporalServices } from './comparisonH06NativeTemporal.js';
import {
  planH06NativeTemporalOperator,
  planH06NativeTemporalServerSetup,
  reopenH06NativeTemporalOperator,
  runH06NativeTemporalOperator,
  runH06NativeTemporalServerSetup,
} from './comparisonH06NativeTemporalOperator.js';
import * as attemptModule from './comparisonH06NativeAttempt.js';
import * as usageModule from './comparisonH06NativeUsage.js';

type ServiceArgs = Parameters<typeof h06NativeTemporalServices>;
type TestStage = (handle: object, started: H04Pin) => Promise<string>;

const ports = vi.hoisted(() => ({
  connect: vi.fn(),
  parent: vi.fn(),
  openParent: vi.fn(),
  close: vi.fn(),
  services: vi.fn<(...args: ServiceArgs) => string>(),
  start:
    vi.fn<
      (
        binding: unknown,
        root: string,
        input: unknown,
        services: string,
        stage: TestStage,
      ) => Promise<string>
    >(),
  client: vi.fn(),
  resumeStart: vi.fn(),
  verifyResume: vi.fn(),
  readResume: vi.fn(),
  server: vi.fn(),
  setup: vi.fn(),
  reopen: vi.fn(),
  usage: vi.fn(),
}));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: ports.parent,
  openH06TemporalAutonomousNativeClaim: ports.openParent,
}));
vi.mock('@temporalio/worker', () => ({ NativeConnection: { connect: ports.connect } }));
vi.mock('@temporalio/client', () => ({
  Client: class {
    constructor(options: unknown) {
      ports.client(options);
    }
  },
}));
vi.mock('./comparisonH06NativeTemporal.js', () => ({
  h06NativeTemporalServices: ports.services,
  startH06NativeTemporal: ports.start,
  readH06NativeTemporalStart: ports.resumeStart,
}));
vi.mock('./comparisonH06NativeTemporalResume.js', () => ({
  verifyH06NativeTemporalResume: ports.verifyResume,
  reopenH06NativeTemporal: ports.reopen,
  readH06NativeTemporalResumeReceipt: ports.readResume,
}));
vi.mock('./comparisonH06NativeTemporalServer.js', () => ({
  verifyH06NativeTemporalServer: ports.server,
}));
vi.mock('./comparisonH06NativeTemporalServerSetup.js', () => ({
  withH06NativeTemporalServer: ports.setup,
}));
vi.mock('./comparisonH06NativeUsage.js', async (original) => ({
  ...(await original<typeof usageModule>()),
  checkH06NativeTemporalAttemptUsage: ports.usage,
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-operator-'));
  roots.push(root);
  const workspaceRoot = join(root, 'material');
  const chatRoot = join(root, 'chat');
  const sessions = join(root, 'sessions');
  for (const dir of [workspaceRoot, chatRoot, sessions]) mkdirSync(dir);
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot, stdio: 'pipe' });
  const materials = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(
    materials.cases.find(({ id }) => id === 'H-06')!.files,
  ))
    writeFileSync(join(workspaceRoot, name), bytes);
  mkdirSync(join(workspaceRoot, 'tasks'));
  mkdirSync(join(workspaceRoot, 'evidence'));
  const file = (name: string, bytes: string, directory = root) => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const workFiles = Object.fromEntries(
    ['rules.md', 'review.md', 'tasks/card.md', 'executor.md'].map((name) => [
      name,
      file(name, name, workspaceRoot).sha256,
    ]),
  );
  const basis = { locator: 'rules.md', hash: workFiles['rules.md']! };
  const evidenceBasis = {
    locator: 'evidence/README.md',
    hash: file('evidence/README.md', 'H06 evidence directory', workspaceRoot).sha256,
  };
  const plan = {
    schema_version: 2,
    plan_id: 'h06',
    requirement: basis,
    basis: [basis, evidenceBasis],
    owner: basis,
    consumers: [basis],
    consumers_complete: true,
    paths: ['evidence/manifest.json'],
    risks: Object.fromEntries(localPlanningRisks.map((risk) => [risk, risk === 'new_behavior'])),
    reason: 'Observe continuity',
    checks: ['syntax', 'validate'],
    criterion: 'Preserve the owner',
  };
  workFiles['plan.json'] = file('plan.json', JSON.stringify(plan), workspaceRoot).sha256;
  const operationId = 'h06-temporal-operator';
  const workflows = file('workflows.js', 'workflows');
  function review(phase: string) {
    const bytes = JSON.stringify({
      schemaVersion: 1,
      phase,
      scope: 'h06',
      sharedPaths: ['checks.mjs', 'plan.json', 'evidence/README.md'],
      roles: [
        {
          roleId: 'reviewer',
          applies: true,
          reason: 'Observe continuity',
          paths: ['checks.mjs'],
          complete: true,
          attestedBy: 'H06 fixture',
          discoveryRule: 'scope',
          history: { complete: true, answers: [] },
        },
      ],
    });
    const pin = file(phase + '.json', bytes);
    return { pin, ref: { sha256: pin.sha256, bytes: Buffer.byteLength(bytes) } };
  }
  const planning = review('planning');
  const acceptance = review('acceptance');
  const profile = { model: 'fixture', effort: 'medium', clientVersion: '0.154.0' };
  const descriptor = {
    kind: 'comparison-h06-native-temporal-bootstrap/2',
    address: '127.0.0.1:7233',
    server: {
      httpPort: 7234,
      metricsPort: 7235,
      sqlitePath: join(root, operationId + '-server', 'temporal.sqlite'),
    },
    taskQueue: 'h06-queue',
    workflows,
    profile,
    disabledServers: ['a', 'b'],
    input: {
      schemaVersion: 11,
      admission: {
        schemaVersion: 3,
        preparation: {
          schemaVersion: 1,
          taskId: 'task',
          project: {
            schemaVersion: 1,
            projectId: 'project',
            workspaceId: 'workspace',
            rules: ['rules.md'],
            cardRoot: 'tasks',
            roles: [{ id: 'reviewer', profile: 'review.md' }],
            checks: ['syntax', 'validate'],
          },
          hostId: operationId,
          owner: 'operator',
          generation: 1,
          revision: 1,
          card: 'tasks/card.md',
        },
        plan: { path: 'plan.json', sha256: workFiles['plan.json']! },
        planning: planning.ref,
        acceptance: acceptance.ref,
      },
      executor: { path: 'executor.md', sha256: workFiles['executor.md']! },
      baseline: 'syntax',
      continuation: { attempt: 0, previous: null },
    },
    workspaceFiles: workFiles,
    artifacts: [planning.pin, acceptance.pin],
  };
  const request = {
    kind: 'comparison-h06-native/2',
    binding: {
      operationId,
      variant: 'temporal',
      workspaceRoot,
      node: file('node', 'node'),
      timeoutMs: 1000,
    },
    evidenceRoot: join(root, operationId),
    chat: { threadId: 'operator-thread', workspace: chatRoot },
    budget: {
      maxElapsedMs: 180000,
      reserveMs: 30000,
      maxManagedStarts: 12,
      maxInputUncached: 10000,
      maxOutput: 3000,
    },
    stimulus: { longStageMs: 35000, initialLeaseMs: null as number | null },
    appServer: file('app-server', 'app-server'),
    server: file('server', 'server') as ReturnType<typeof file> | null,
    bootstrap: file('bootstrap.json', JSON.stringify(descriptor)),
    runtime: [workflows, planning.pin, acceptance.pin],
  };
  vi.stubEnv('CODEX_HOME', root);
  vi.stubEnv('CODEX_THREAD_ID', request.chat.threadId);
  function authority(body = planH06NativeAttempt(request).expectedGrantText) {
    const transcript = join(sessions, 'session.jsonl');
    const turnId = 'native-turn';
    const records = [
      {
        type: 'session_meta',
        payload: {
          id: request.chat.threadId,
          session_id: request.chat.threadId,
          cwd: chatRoot,
          cli_version: '0.154.0',
        },
      },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      {
        type: 'turn_context',
        payload: {
          turn_id: turnId,
          cwd: chatRoot,
          model: 'fixture',
          effort: 'medium',
          approval_policy: 'never',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
        },
      },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
      },
    ].map((record) => JSON.stringify(record) + '\n');
    writeFileSync(transcript, records.join(''));
    return {
      transcript,
      turnId,
      source: { locator: transcript + '#L4', hash: digest(records[3]!) },
    };
  }
  const connection = { close: ports.close };
  ports.connect.mockResolvedValue(connection);
  ports.services.mockReturnValue('bound services');
  ports.start.mockResolvedValue('stage result');
  ports.readResume.mockReturnValue(null);
  ports.server.mockResolvedValue(undefined);
  const serverProof = file('server-owner.json', 'server owner');
  return { request, descriptor, authority, connection, file, plan, serverProof };
}

it('assembles exactly the granted host and durable transport callbacks', async () => {
  const f = fixture();
  expect(planH06NativeTemporalOperator(f.request).mayRun).toBe(false);
  const handle = { workflowId: 'test-workflow' };
  const started = f.descriptor.workflows;
  const run = vi.fn(async () => 'stage result');
  ports.start.mockImplementation(async (_binding, _root, _input, _services, stage) =>
    stage(handle, started),
  );
  await expect(
    runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, run),
  ).resolves.toBe('stage result');
  expect(ports.connect).toHaveBeenCalledExactlyOnceWith({ address: f.descriptor.address });
  expect(ports.server).toHaveBeenCalledTimes(3);
  expect(ports.server).toHaveBeenNthCalledWith(
    2,
    {
      requestHash: expect.stringMatching(/^[a-f\d]{64}$/u) as unknown,
      binary: f.request.server,
      address: f.descriptor.address,
      ...f.descriptor.server,
    },
    f.serverProof,
    expect.any(Number),
  );
  expect(ports.server.mock.invocationCallOrder[1]).toBeLessThan(
    ports.connect.mock.invocationCallOrder[0]!,
  );
  expect(ports.server.mock.invocationCallOrder[2]).toBeGreaterThan(
    ports.connect.mock.invocationCallOrder[0]!,
  );
  expect(ports.client).toHaveBeenCalledExactlyOnceWith({ connection: f.connection });
  const [services, options] = ports.services.mock.calls[0]!;
  const { binding, budget, evidenceRoot, appServer } = f.request;
  expect(services).toMatchObject({
    connection: f.connection,
    taskQueue: f.descriptor.taskQueue,
    workflowsPath: f.descriptor.workflows.path,
    maxTurnStarts: budget.maxManagedStarts,
    issuer: {
      workspaceRoot: f.request.chat.workspace,
      threadId: f.request.chat.threadId,
      owner: 'operator',
    },
    registration: {
      hostId: binding.operationId,
      owner: 'operator',
      workspaceRoot: binding.workspaceRoot,
      commands: {
        syntax: {
          executable: binding.node.path,
          args: ['--check', 'checks.mjs'],
          timeoutMs: binding.timeoutMs,
        },
        validate: {
          executable: binding.node.path,
          args: ['checks.mjs'],
          timeoutMs: binding.timeoutMs,
        },
      },
    },
  });
  expect(options).toMatchObject({
    profile: f.descriptor.profile,
    binary: appServer,
    disabledServers: ['a', 'b'],
    evidenceRoot: join(evidenceRoot, 'transport-initial'),
  });
  expect(typeof options.admitTurn).toBe('function');
  expect(typeof options.recordTurn).toBe('function');
  expect(options.stopDeadlineMs - services.workDeadlineMs).toBe(budget.reserveMs);
  expect(ports.start).toHaveBeenCalledExactlyOnceWith(
    binding,
    evidenceRoot,
    f.descriptor.input,
    'bound services',
    expect.any(Function),
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(
    handle,
    started,
    expect.any(AbortSignal),
    'bound services',
  );
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it('refuses generic text before any SDK connection', async () => {
  const f = fixture();
  await expect(
    runH06NativeTemporalOperator(
      f.request,
      f.authority('разрешаю продолжить'),
      f.serverProof,
      vi.fn(),
    ),
  ).rejects.toThrow('authority-body');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(ports.connect).not.toHaveBeenCalled();
});

it.each([0, 1, 2])(
  'refuses an unconfirmed owner at each server observation (%d)',
  async (index) => {
    const f = fixture();
    let observations = 0;
    ports.server.mockImplementation(async () => {
      if (observations++ === index) throw new Error('server owner changed');
    });
    await expect(
      runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, vi.fn()),
    ).rejects.toThrow('server owner changed');
    expect(ports.connect).toHaveBeenCalledTimes(index === 2 ? 1 : 0);
    expect(ports.close).toHaveBeenCalledTimes(index === 2 ? 1 : 0);
    expect(ports.start).not.toHaveBeenCalled();
    expect(existsSync(f.request.evidenceRoot)).toBe(index !== 0);
  },
);

it.each(['7234', 1.5, 0, 65536, 7233, 'foreign-db'])(
  'refuses an invalid or overlapping server configuration (%s)',
  (change) => {
    const f = fixture();
    const server =
      change === 'foreign-db'
        ? { ...f.descriptor.server, sqlitePath: '/other.sqlite' }
        : { ...f.descriptor.server, httpPort: change };
    f.request.bootstrap = f.file('bootstrap.json', JSON.stringify({ ...f.descriptor, server }));
    expect(() => planH06NativeTemporalOperator(f.request)).toThrow(
      /h06-temporal-operator-(endpoint|server-scope)/u,
    );
    expect(ports.server).not.toHaveBeenCalled();
  },
);

it.each([
  'kind',
  'remote',
  'invalid-port',
  'workflows',
  'profile',
  'server-list',
  'server-name',
  'server-duplicate',
  'baseline',
  'checks',
  'host',
  'attempt',
  'file-digest',
  'input-digest',
  'artifact-missing',
  'artifact-duplicate',
  'artifact-unpinned',
  'artifact-empty',
] as const)('refuses the mismatched pinned %s before a claim', (which) => {
  const { request, descriptor, file } = fixture();
  const changed: Record<string, unknown> = { ...descriptor };
  if (which === 'kind') changed.kind = 'wrong';
  if (which === 'remote') changed.address = 'server:7233';
  if (which === 'invalid-port') changed.address = '127.0.0.1:65536';
  if (which === 'workflows') changed.workflows = request.appServer;
  if (which === 'profile') descriptor.profile.clientVersion = '0.165.0';
  if (which === 'server-list') changed.disabledServers = 'a';
  if (which === 'server-name') descriptor.disabledServers.push('bad/name');
  if (which === 'server-duplicate') descriptor.disabledServers.push('a');
  if (which === 'baseline') descriptor.input.baseline = 'validate';
  if (which === 'checks') descriptor.input.admission.preparation.project.checks = ['syntax'];
  if (which === 'host') descriptor.input.admission.preparation.hostId = 'foreign';
  if (which === 'attempt') descriptor.input.continuation.attempt = 1;
  if (which === 'file-digest') descriptor.workspaceFiles['rules.md'] = digest('other');
  if (which === 'input-digest') descriptor.input.executor.sha256 = digest('other');
  if (which === 'artifact-missing') descriptor.artifacts.pop();
  if (which === 'artifact-duplicate') descriptor.artifacts.push(descriptor.artifacts[0]!);
  if (which === 'artifact-unpinned') descriptor.artifacts.push(request.appServer);
  if (which === 'artifact-empty') changed.artifacts = [];
  request.bootstrap = file('bootstrap.json', JSON.stringify(changed));
  expect(() => planH06NativeTemporalOperator(request)).toThrow();
  expect(existsSync(request.evidenceRoot)).toBe(false);
  expect(ports.connect).not.toHaveBeenCalled();
});

it('rejects a Legacy attempt in the Temporal operator', () => {
  const f = fixture();
  f.request.binding.variant = 'legacy';
  f.request.server = null;
  f.request.stimulus.initialLeaseMs = 20000;
  expect(() => planH06NativeTemporalOperator(f.request)).toThrow('h06-temporal-operator-variant');
});

it.each([
  { paths: ['checks.mjs'] },
  { paths: ['evidence/other.json'] },
  { paths: ['evidence/manifest.json', 'evidence/README.md'] },
  { basis: [{ locator: 'rules.md', hash: digest('rules.md') }] },
  { checks: ['syntax'] },
  { checks: ['validate', 'foreign'] },
])('rejects the pinned plan outside the accepted H06 scope (%j)', (change) => {
  const f = fixture();
  const plan = f.file(
    'plan.json',
    JSON.stringify({ ...f.plan, ...change }),
    f.request.binding.workspaceRoot,
  );
  f.descriptor.workspaceFiles['plan.json'] = plan.sha256;
  f.descriptor.input.admission.plan.sha256 = plan.sha256;
  f.request.bootstrap = f.file('bootstrap.json', JSON.stringify(f.descriptor));
  expect(() => planH06NativeTemporalOperator(f.request)).toThrow(
    'h06-temporal-operator-plan-scope',
  );
});

it.each([false, true])(
  'requires the material root to be its own Git workspace (parent repository: %s)',
  (parent) => {
    const f = fixture();
    const root = f.request.binding.workspaceRoot;
    rmSync(join(root, '.git'), { recursive: true });
    if (parent) execFileSync('git', ['init', '--quiet'], { cwd: dirname(root), stdio: 'pipe' });
    expect(() => planH06NativeTemporalOperator(f.request)).toThrow(
      'h06-temporal-operator-git-workspace',
    );
  },
);

it('rejects a planning review reference in place of acceptance', () => {
  const f = fixture();
  f.descriptor.input.admission.acceptance = f.descriptor.input.admission.planning;
  f.request.bootstrap = f.file('bootstrap.json', JSON.stringify(f.descriptor));
  expect(() => planH06NativeTemporalOperator(f.request)).toThrow(
    'h06-temporal-operator-review-phase',
  );
});

it('passes the real substantial-task preparation without an RPC or model turn', async () => {
  const f = fixture();
  expect(planH06NativeTemporalOperator(f.request).mayRun).toBe(false);
  const input = parseLocalTask(f.descriptor.input);
  if (input.schemaVersion !== 11) throw new Error('fixture input must use ManagedTaskWorkflow');
  const artifactRoot = join(dirname(f.request.evidenceRoot), 'preflight');
  const store = artifactStore(artifactRoot);
  for (const pin of f.descriptor.artifacts) store.publish(readH04Pin(pin));
  const { preparation } = input.admission;
  const rpc = { request: vi.fn(), completed: vi.fn() };
  const prepared = await preflightSubstantialTask(
    {
      ...preparation,
      workspaceRoot: f.request.binding.workspaceRoot,
      artifactRoot,
      commands: {
        syntax: { executable: f.request.binding.node.path, args: ['--check', 'checks.mjs'] },
        validate: { executable: f.request.binding.node.path, args: ['checks.mjs'] },
      },
    },
    input,
    rpc,
    f.descriptor.profile,
  );
  expect(prepared).toHaveProperty('manifest');
  const manifest = JSON.parse(store.read(prepared.manifest).toString()) as {
    tree: { directories: { path: string }[] };
  };
  expect(manifest.tree.directories.map(({ path }) => path)).toContain('evidence');
  expect(existsSync(join(f.request.binding.workspaceRoot, 'evidence', 'manifest.json'))).toBe(
    false,
  );
  expect(rpc.request).not.toHaveBeenCalled();
  expect(rpc.completed).not.toHaveBeenCalled();
});

it.each([
  'scope',
  'applicable',
  'unresolved',
  'incomplete',
  'history',
  'plan-path',
  'source-path',
] as const)('rejects a pinned review request that production cannot prepare (%s)', (which) => {
  const f = fixture();
  const original = f.descriptor.artifacts[0]!;
  const review = JSON.parse(readH04Pin(original).toString()) as {
    scope: string;
    sharedPaths: string[];
    roles: {
      applies: boolean | null;
      complete: boolean;
      paths: string[];
      history: { complete: boolean };
    }[];
  };
  const role = review.roles[0]!;
  if (which === 'scope') review.scope = 'wrong';
  if (which === 'applicable') role.applies = false;
  if (which === 'unresolved') {
    role.applies = null;
    review.roles.push({ ...role, applies: true, ...{ roleId: 'second' } });
    f.descriptor.input.admission.preparation.project.roles.push({
      id: 'second',
      profile: 'review.md',
    });
  }
  if (which === 'incomplete') role.complete = false;
  if (which === 'history') role.history.complete = false;
  if (which === 'plan-path') review.sharedPaths = ['checks.mjs'];
  if (which === 'source-path') {
    const changed = {
      ...f.plan,
      owner: {
        locator: 'assignment.json',
        hash: digest(readFileSync(join(f.request.binding.workspaceRoot, 'assignment.json'))),
      },
    };
    const pin = f.file('plan.json', JSON.stringify(changed), f.request.binding.workspaceRoot);
    f.descriptor.workspaceFiles['plan.json'] = pin.sha256;
    f.descriptor.input.admission.plan.sha256 = pin.sha256;
  }
  const bytes = JSON.stringify(review);
  const pin = f.file('planning.json', bytes);
  f.descriptor.artifacts[0] = pin;
  f.request.runtime = f.request.runtime.map((entry) => (entry.path === pin.path ? pin : entry));
  f.descriptor.input.admission.planning = { sha256: pin.sha256, bytes: Buffer.byteLength(bytes) };
  f.request.bootstrap = f.file('bootstrap.json', JSON.stringify(f.descriptor));
  expect(() => planH06NativeTemporalOperator(f.request)).toThrow(
    /h06-temporal-operator-review-(scope|inputs)/u,
  );
});

it.each([false, true])(
  'closes the SDK connection after stage error (cleanup fails %s)',
  async (cleanupFails) => {
    const f = fixture();
    const error = new Error('stage error');
    const cleanup = new Error('close error');
    ports.start.mockRejectedValue(error);
    if (cleanupFails) ports.close.mockRejectedValue(cleanup);
    const result = runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, vi.fn());
    if (cleanupFails) await expect(result).rejects.toMatchObject({ errors: [error, cleanup] });
    else await expect(result).rejects.toBe(error);
    expect(ports.close).toHaveBeenCalledTimes(1);
  },
);

it('refuses to start a Worker if SDK connection uses the remaining work time', async () => {
  const f = fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  ports.connect.mockImplementation(async () => {
    const { maxElapsedMs, reserveMs } = f.request.budget;
    vi.spyOn(Date, 'now').mockReturnValue(now + maxElapsedMs - reserveMs - 10000);
    return f.connection;
  });
  await expect(
    runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, vi.fn()),
  ).rejects.toThrow('h06-temporal-operator-deadline');
  expect(ports.start).not.toHaveBeenCalled();
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it('reports a late cleanup as unconfirmed', async () => {
  const f = fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  ports.close.mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + f.request.budget.maxElapsedMs + 1);
  });
  await expect(
    runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, vi.fn()),
  ).rejects.toThrow('h06-temporal-operator-stop-deadline');
});

it.each([0, 10])(
  'closes the SDK when the driver runs out of work time (%d ms left)',
  async (remaining) => {
    const f = fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    ports.services.mockImplementation(({ workDeadlineMs }) => {
      clock.mockReturnValue(workDeadlineMs - remaining);
      return 'bound services';
    });
    ports.start.mockImplementation(async (_binding, _root, _input, _services, stage) =>
      stage({}, f.descriptor.workflows),
    );
    const stopped = vi.fn();
    const run = vi.fn(
      async (_handle, _started, signal: AbortSignal) =>
        new Promise<never>(() => signal.addEventListener('abort', stopped, { once: true })),
    );
    await expect(
      runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, run),
    ).rejects.toThrow('h06-temporal-operator-deadline');
    expect(run).toHaveBeenCalledTimes(remaining ? 1 : 0);
    expect(stopped).toHaveBeenCalledTimes(remaining ? 1 : 0);
    expect(ports.close).toHaveBeenCalledTimes(1);
  },
);

it('does not start a Worker if approved workflow bytes drift during SDK connection', async () => {
  const f = fixture();
  ports.connect.mockImplementation(async () => {
    writeFileSync(f.descriptor.workflows.path, 'different workflows');
    return f.connection;
  });
  await expect(
    runH06NativeTemporalOperator(f.request, f.authority(), f.serverProof, vi.fn()),
  ).rejects.toThrow('h04-pin-changed');
  expect(ports.start).not.toHaveBeenCalled();
  expect(ports.close).toHaveBeenCalledTimes(1);
});

async function reopenFixture(phase: 'warm' | 'cold' = 'warm', maxManagedStarts = 12) {
  const f = fixture();
  f.request.budget.maxManagedStarts = maxManagedStarts;
  const claim = await beginH06NativeAttempt(f.request, f.authority());
  const evidence = f.request.evidenceRoot;
  const initial = join(evidence, 'transport-initial');
  const stops = [{ path: join(initial, 'transport-stop.json'), sha256: digest('initial') }];
  if (phase === 'cold')
    stops.push({
      path: join(evidence, 'transport-warm', 'transport-stop.json'),
      sha256: digest('warm'),
    });
  const resume = {
    started: f.file('temporal-start.json', 'fixture start', evidence),
    status: f.descriptor.artifacts[0]!,
    commandId: 'resume',
  };
  const input = f.descriptor.input;
  const start = { transportRoot: initial };
  ports.resumeStart.mockReturnValue({ start, evidence, input });
  ports.usage.mockReturnValue({
    status: 'WITHIN_BUDGET',
    knownSubtotal: { inputUncached: 12, output: 2 },
    binding: { participants: [] },
  });
  ports.verifyResume.mockResolvedValue(undefined);
  ports.reopen.mockResolvedValue('reopened');
  const ledger = openH06NativeAttemptTurnLedger(claim.receipt);
  const turn = {
    role: 'reader' as const,
    root: f.request.binding.workspaceRoot,
    session: 'reader-session',
    journal: join(initial, 'reader-0.jsonl'),
    params: { threadId: 'reader-session', input: [{ type: 'text', text: 'read' }] },
  };
  await ledger.admitTurn(turn);
  await ledger.recordTurn({
    ...turn,
    turnId: 'reader-turn',
    response: { turn: { id: 'reader-turn' } },
  });
  const retained: Parameters<typeof reopenH06NativeTemporalOperator>[0] = {
    claim: claim.receipt,
    server: f.serverProof,
    resume,
    opening:
      phase === 'warm'
        ? { phase }
        : { phase, warm: f.descriptor.workflows, readers: [], tasks: [] },
    command: { commandId: 'resume' } as PayloadReaderCommand,
    stops,
    participants: [],
  };
  f.file('temporal-server-owner.json', JSON.stringify(f.serverProof), evidence);
  return { ...f, retained, start, evidence, input, claim, ledger, turn };
}

it('returns the exact retained RESUME without opening the expired stage or its server', async () => {
  const f = await reopenFixture();
  const previous = {
    ack: { commandId: 'resume' },
    receipt: f.descriptor.workflows,
    opened: f.descriptor.workflows,
  };
  ports.readResume.mockReturnValue(previous);
  vi.spyOn(Date, 'now').mockReturnValue(f.claim.stopDeadlineMs + 1);
  writeFileSync(join(f.request.binding.workspaceRoot, 'evidence', 'manifest.json'), '{}');
  const run = vi.fn();
  await expect(reopenH06NativeTemporalOperator(f.retained, run)).resolves.toEqual(previous);
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.server).not.toHaveBeenCalled();
  expect(ports.usage).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each(['unknown', 'start-path', 'owner'] as const)(
  'refuses retained state before server observation (%s)',
  async (which) => {
    const f = await reopenFixture();
    if (which === 'unknown')
      ports.readResume.mockImplementation(() => {
        throw new Error('resume unknown');
      });
    if (which === 'start-path') f.retained.resume.started = f.descriptor.workflows;
    if (which === 'owner') f.retained.server = f.descriptor.workflows;
    await expect(reopenH06NativeTemporalOperator(f.retained, vi.fn())).rejects.toThrow();
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.server).not.toHaveBeenCalled();
  },
);

it.each(['warm', 'cold'] as const)(
  'reopens the %s stage with the retained budget and exact authority',
  async (phase) => {
    const f = await reopenFixture(phase);
    const opened = f.descriptor.workflows;
    const result = { ack: { commandId: 'resume' }, receipt: opened };
    ports.reopen.mockImplementation(
      async (
        _resume,
        _services,
        _command,
        _phase,
        continuation: (resumed: typeof result, opened: H04Pin) => Promise<string>,
      ) => continuation(result, opened),
    );
    const run = vi.fn(async () => 'continued');
    await expect(reopenH06NativeTemporalOperator(f.retained, run)).resolves.toBe('continued');
    expect(ports.verifyResume).toHaveBeenCalledExactlyOnceWith(
      f.retained.resume,
      expect.objectContaining({
        threadId: f.request.chat.threadId,
        workspaceRoot: f.request.chat.workspace,
      }),
      f.retained.command,
    );
    expect(ports.verifyResume.mock.invocationCallOrder[0]).toBeLessThan(
      ports.connect.mock.invocationCallOrder[0]!,
    );
    expect(ports.usage).toHaveBeenCalledExactlyOnceWith({
      claim: f.retained.claim,
      stops: f.retained.stops,
      participants: [],
    });
    const [services, transport] = ports.services.mock.calls[0]!;
    expect(services.workDeadlineMs).toBe(f.claim.workDeadlineMs);
    expect(transport.stopDeadlineMs).toBe(f.claim.stopDeadlineMs);
    expect(transport.evidenceRoot).toBe(join(f.evidence, 'transport-' + phase));
    expect(transport.retainedReaderSessions).toEqual(['reader-session']);
    expect(ports.reopen).toHaveBeenCalledExactlyOnceWith(
      f.retained.resume,
      'bound services',
      f.retained.command,
      f.retained.opening,
      expect.any(Function),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      result,
      opened,
      expect.any(AbortSignal),
      'bound services',
    );
    expect(ports.close).toHaveBeenCalledTimes(1);
  },
);

it.each([
  'phase',
  'evidence',
  'initial-transport',
  'input',
  'expired',
  'prior-stops',
  'authority',
  'unknown-usage',
  'over-budget',
  'input-cap',
  'output-cap',
  'unknown-turn',
  'start-cap',
] as const)('refuses an unsafe reopen before connecting (%s)', async (which) => {
  const f = await reopenFixture('warm', which === 'start-cap' ? 1 : 12);
  if (which === 'phase') Object.assign(f.retained.opening, { phase: 'other' });
  if (which === 'evidence')
    ports.resumeStart.mockReturnValue({ start: f.start, input: f.input, evidence: '/other' });
  if (which === 'initial-transport') f.start.transportRoot += '-other';
  if (which === 'input') f.input.admission.preparation.owner = 'other';
  if (which === 'expired') vi.spyOn(Date, 'now').mockReturnValue(f.claim.workDeadlineMs);
  if (which === 'prior-stops') f.retained.stops = [];
  if (which === 'authority')
    ports.verifyResume.mockRejectedValueOnce(new Error('invalid authority'));
  if (which === 'unknown-usage' || which === 'over-budget')
    ports.usage.mockReturnValue({ status: which === 'unknown-usage' ? 'UNKNOWN' : 'OVER_BUDGET' });
  if (which === 'input-cap' || which === 'output-cap')
    ports.usage.mockReturnValue({
      status: 'WITHIN_BUDGET',
      knownSubtotal: {
        inputUncached: which === 'input-cap' ? f.request.budget.maxInputUncached : 12,
        output: which === 'output-cap' ? f.request.budget.maxOutput : 2,
      },
    });
  if (which === 'unknown-turn')
    await f.ledger.admitTurn({
      ...f.turn,
      params: { ...f.turn.params, input: [{ type: 'text', text: 'unknown' }] },
    });
  await expect(reopenH06NativeTemporalOperator(f.retained, vi.fn())).rejects.toThrow();
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.reopen).not.toHaveBeenCalled();
});

it.each([false, true])(
  'uses the complete current transcript after STOP (prefix: %s)',
  async (prefix) => {
    const f = await reopenFixture();
    const transcript = join(f.evidence, 'reader.jsonl');
    writeFileSync(transcript, '{"type":"session_meta"}\n');
    const participant = {
      transcript,
      session: f.turn.session,
      run: f.request.binding.operationId,
      stage: 'execution' as const,
    };
    const prior = usageModule.sealH06NativeUsage(participant);
    f.retained.participants = [prior];
    if (prefix) writeFileSync(transcript, '{"type":"session_meta"}\n{"type":"event_msg"}\n');
    ports.usage.mockReturnValue({
      status: 'WITHIN_BUDGET',
      knownSubtotal: { inputUncached: 12, output: 2 },
      binding: { participants: [participant] },
    });
    const result = reopenH06NativeTemporalOperator(f.retained, vi.fn());
    if (prefix) {
      await expect(result).rejects.toThrow('h06-temporal-operator-reopen-usage-boundary');
      expect(ports.connect).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe('reopened');
    }
  },
);

const setupBudget = { maxElapsedMs: 240000, stopReserveMs: 30000 };

it('refuses an already cancelled manual setup before observing or reserving its grant', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('manual cancelled'));
  await expect(
    runH06NativeTemporalServerSetup(f.request, setupBudget, null, vi.fn(), controller.signal),
  ).rejects.toThrow('manual cancelled');
  expect(ports.setup).not.toHaveBeenCalled();
  expect(existsSync(dirname(f.descriptor.server.sqlitePath))).toBe(false);
});

it('carries cancellation before READY to the manual supervisor and retains its once-only reservation', async () => {
  const f = fixture();
  const plan = planH06NativeTemporalServerSetup(f.request, setupBudget);
  const grant = f.authority(plan.expectedGrantText);
  const controller = new AbortController();
  const run = vi.fn();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  ports.setup.mockImplementation(async (setup: { signal: AbortSignal }) => {
    expect(setup.signal).toBe(controller.signal);
    enter();
    return new Promise((_resolve, reject) =>
      setup.signal.addEventListener('abort', () => reject(setup.signal.reason), { once: true }),
    );
  });
  const pending = runH06NativeTemporalServerSetup(
    f.request,
    setupBudget,
    grant,
    run,
    controller.signal,
  );
  await entered;
  controller.abort(new Error('manual cancelled before READY'));
  await expect(pending).rejects.toThrow('manual cancelled before READY');
  expect(run).not.toHaveBeenCalled();
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.start).not.toHaveBeenCalled();
  expect(existsSync(join(plan.root, 'setup-claim.json'))).toBe(true);
  await expect(runH06NativeTemporalServerSetup(f.request, setupBudget, grant, run)).rejects.toThrow(
    'h06-temporal-server-setup-not-fresh',
  );
  expect(ports.setup).toHaveBeenCalledTimes(1);
});

it('uses a separate exact setup grant and gives only the owned server directory to the supervisor', async () => {
  const f = fixture();
  const plan = planH06NativeTemporalServerSetup(f.request, setupBudget);
  expect(plan.mayRun).toBe(false);
  expect(plan.expectedGrantText).not.toBe(plan.attempt.expectedGrantText);
  expect(JSON.parse(plan.expectedGrantText) as unknown).toMatchObject({
    kind: 'comparison-h06-native-temporal-server-setup-grant/2',
    requestHash: plan.attempt.requestHash,
    setupHash: plan.setupHash,
    budget: setupBudget,
  });
  expect(plan.root).toBe(dirname(f.descriptor.server.sqlitePath));
  expect(existsSync(plan.root)).toBe(false);
  const run = vi.fn();
  const proof = { result: 'stage', ready: f.serverProof, stopped: f.serverProof };
  ports.setup.mockResolvedValue(proof);
  await expect(
    runH06NativeTemporalServerSetup(
      f.request,
      setupBudget,
      f.authority(plan.expectedGrantText),
      run,
    ),
  ).resolves.toEqual(proof);
  expect(ports.setup).toHaveBeenCalledExactlyOnceWith(
    {
      expected: {
        requestHash: plan.attempt.requestHash,
        binary: f.request.server,
        address: f.descriptor.address,
        ...f.descriptor.server,
      },
      deadlineMs: expect.any(Number) as unknown,
      stopReserveMs: setupBudget.stopReserveMs,
    },
    run,
  );
  expect(
    JSON.parse(readFileSync(join(plan.root, 'setup-claim.json'), 'utf8')) as unknown,
  ).toMatchObject({
    kind: 'comparison-h06-native-temporal-server-setup-claim/2',
    setupHash: plan.setupHash,
    budget: setupBudget,
  });
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.start).not.toHaveBeenCalled();
});

it.each([
  { maxElapsedMs: '240000' },
  { maxElapsedMs: 240000.5 },
  { maxElapsedMs: 2 ** 31 },
  { stopReserveMs: '30000' },
  { stopReserveMs: 30000.5 },
  { stopReserveMs: 0 },
  { maxElapsedMs: 210000 },
])('refuses invalid or insufficient setup budget %j', (change) => {
  const f = fixture();
  expect(() => planH06NativeTemporalServerSetup(f.request, { ...setupBudget, ...change })).toThrow(
    'h06-temporal-server-setup-budget',
  );
  expect(ports.setup).not.toHaveBeenCalled();
});

it('rejects the exact native attempt grant and generic text as server setup authority', async () => {
  const f = fixture();
  for (const body of [planH06NativeTemporalOperator(f.request).expectedGrantText, 'continue'])
    await expect(
      runH06NativeTemporalServerSetup(f.request, setupBudget, f.authority(body), vi.fn()),
    ).rejects.toThrow('h06-native-attempt-authority-body');
  expect(ports.setup).not.toHaveBeenCalled();
  expect(existsSync(dirname(f.descriptor.server.sqlitePath))).toBe(false);
});

it('does not consume the exact server setup grant as native attempt authority', async () => {
  const f = fixture();
  const { expectedGrantText } = planH06NativeTemporalServerSetup(f.request, setupBudget);
  await expect(
    runH06NativeTemporalOperator(f.request, f.authority(expectedGrantText), f.serverProof, vi.fn()),
  ).rejects.toThrow('h06-native-attempt-authority-body');
  expect(existsSync(f.request.evidenceRoot)).toBe(false);
  expect(ports.connect).not.toHaveBeenCalled();
});

it('refuses changed setup bounds after reading the initial primary grant', async () => {
  const f = fixture();
  const budget = { ...setupBudget };
  const plan = planH06NativeTemporalServerSetup(f.request, budget);
  const pending = runH06NativeTemporalServerSetup(
    f.request,
    budget,
    f.authority(plan.expectedGrantText),
    vi.fn(),
  );
  budget.maxElapsedMs += 1000;
  await expect(pending).rejects.toThrow('h06-temporal-server-setup-changed');
  expect(ports.setup).not.toHaveBeenCalled();
  expect(existsSync(plan.root)).toBe(false);
});

it('claims server setup once even when the supervisor fails', async () => {
  const f = fixture();
  const plan = planH06NativeTemporalServerSetup(f.request, setupBudget);
  const grant = f.authority(plan.expectedGrantText);
  ports.setup.mockRejectedValue(new Error('server stop unknown'));
  await expect(
    runH06NativeTemporalServerSetup(f.request, setupBudget, grant, vi.fn()),
  ).rejects.toThrow('server stop unknown');
  await expect(
    runH06NativeTemporalServerSetup(f.request, setupBudget, grant, vi.fn()),
  ).rejects.toThrow('h06-temporal-server-setup-not-fresh');
  expect(ports.setup).toHaveBeenCalledTimes(1);
  expect(existsSync(join(plan.root, 'setup-claim.json'))).toBe(true);
});

it.each([false, true])(
  'reuses the pre-admitted autonomous claim and rejects request mismatch=%s',
  async (mismatch) => {
    const f = fixture(),
      claim = await beginH06NativeAttempt(f.request, f.authority());
    const mode = {
      kind: 'temporal-autonomous/3',
      authority: f.file('parent.json', 'parent'),
    } as const;
    ports.parent.mockReturnValue({});
    ports.openParent.mockReturnValue({ ...claim, grant: { ...claim.grant, admission: mode } });
    const begin = vi.spyOn(attemptModule, 'beginH06NativeAttempt');
    const request = mismatch
      ? {
          ...f.request,
          budget: { ...f.request.budget, maxManagedStarts: f.request.budget.maxManagedStarts + 1 },
        }
      : f.request;
    if (mismatch)
      await expect(
        runH06NativeTemporalOperator(request, mode, f.serverProof, async () => 'done'),
      ).rejects.toThrow('h06-temporal-operator-autonomous-request');
    else {
      await expect(
        runH06NativeTemporalOperator(request, mode, f.serverProof, async () => 'done'),
      ).resolves.toBe('stage result');
      expect(ports.server.mock.calls[0]![2]).toBe(claim.workDeadlineMs);
      expect(ports.services.mock.calls[0]![1].writerStimulus).toEqual({
        node: f.request.binding.node,
        minimumMs: f.request.stimulus.longStageMs,
      });
      expect(ports.services.mock.calls[0]![0]).toMatchObject({
        controlMode: mode,
        workDeadlineMs: claim.workDeadlineMs,
      });
    }
    expect(begin).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'preserves the autonomous mode across cold IPC and rejects mismatch=%s',
  async (mismatch) => {
    const f = await reopenFixture('cold');
    const mode = {
      kind: 'temporal-autonomous/3',
      authority: f.file('parent.json', 'parent'),
    } as const;
    ports.parent.mockReturnValue({});
    const admitted = { ...f.claim, grant: { ...f.claim.grant, admission: mode } };
    vi.spyOn(attemptModule, 'readH06NativeAttemptForReopen').mockReturnValue(admitted);
    f.retained.controlMode = mismatch
      ? { ...mode, authority: f.file('other.json', 'other') }
      : mode;
    if (mismatch)
      await expect(reopenH06NativeTemporalOperator(f.retained, async () => 'done')).rejects.toThrow(
        'h06-temporal-operator-reopen-mode',
      );
    else
      await expect(reopenH06NativeTemporalOperator(f.retained, async () => 'done')).resolves.toBe(
        'reopened',
      );
  },
);

it.each(['warm', 'cold'] as const)(
  'applies the H06 Writer stimulus only before the final cold implementation: %s',
  async (phase) => {
    const f = await reopenFixture(phase),
      mode = { kind: 'temporal-autonomous/3', authority: f.file('parent.json', 'parent') } as const;
    ports.parent.mockReturnValue({});
    const admitted = { ...f.claim, grant: { ...f.claim.grant, admission: mode } };
    vi.spyOn(attemptModule, 'readH06NativeAttemptForReopen').mockReturnValue(admitted);
    f.retained.controlMode = mode;
    await reopenH06NativeTemporalOperator(f.retained, async () => 'done');
    const transport = ports.services.mock.calls[0]![1];
    if (phase === 'warm')
      expect(transport.writerStimulus).toEqual({
        node: f.request.binding.node,
        minimumMs: f.request.stimulus.longStageMs,
      });
    else expect(transport.writerStimulus).toBeUndefined();
  },
);
