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
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import { digest } from '../src/adapters/artifacts/files.js';
import { bindTaskBackendClient } from '../src/client/taskBackend.js';
import { localTaskKey } from '../src/policy/localTask.js';
import type { ManagedTaskInput } from '../src/contracts/localTask.js';
import { readH04Pin } from './comparisonH04Contract.js';
import { h06Assets } from './comparisonH06Contract.js';
import {
  checkH06NativeFailure,
  type H06NativeFailureBinding,
} from './comparisonH06NativeFailure.js';
import {
  h06NativeTemporalServices,
  readH06NativeHostOwner,
  startH06NativeTemporal,
} from './comparisonH06NativeTemporal.js';

const parent = vi.hoisted(() => vi.fn());
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: parent,
}));
const createHost = vi.hoisted(() => vi.fn());
const openTransport = vi.hoisted(() => vi.fn());
vi.mock('../src/worker/readerHost.js', () => ({ createReaderHost: createHost }));
vi.mock('./comparisonH06NativeTransport.js', () => ({ openH06NativeTransport: openTransport }));

const roots: string[] = [];
afterEach(() => {
  createHost.mockReset();
  openTransport.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-temporal-start-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace'),
    evidence = join(root, 'evidence'),
    artifactRoot = join(evidence, 'artifacts');
  mkdirSync(workspaceRoot);
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const material = JSON.parse(readH04Pin(h06Assets().materials).toString()) as {
    cases: { id: string; files: Record<string, string> }[];
  };
  for (const [name, bytes] of Object.entries(material.cases.find(({ id }) => id === 'H-06')!.files))
    writeFileSync(join(workspaceRoot, name), bytes);

  const node = realpathSync(process.execPath);
  const binding: H06NativeFailureBinding = {
    operationId: 'h06-native-test',
    variant: 'temporal',
    workspaceRoot,
    node: { path: node, sha256: digest(readFileSync(node)) },
    timeoutMs: 3000,
  };
  const project = {
    schemaVersion: 1 as const,
    projectId: 'h06-native-test',
    workspaceId: 'workspace',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['validate'],
  };
  const preparation = {
    schemaVersion: 1 as const,
    project,
    taskId: 'one',
    hostId: binding.operationId,
    owner: 'task-owner',
    generation: 4,
    revision: 2,
    card: 'tasks/one.md',
  };
  const proof = { sha256: digest('artifact'), bytes: 8 };
  const input: ManagedTaskInput = {
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation,
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: proof,
      acceptance: proof,
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'validate',
    continuation: { attempt: 0, previous: null },
  };
  const registration = { ...preparation, workspaceRoot, artifactRoot, commands: {} };
  const workflowId = localTaskKey(input);
  const handle = {
    workflowId,
    firstExecutionRunId: 'native-run-1',
    query: vi.fn(async () => input),
  };
  const start = vi.fn(async () => {
    expect(existsSync(join(evidence, 'f01', 'receipt.json'))).toBe(true);
    return handle;
  });
  const close = vi.fn();
  const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion: '0.154.0' };
  const stopTransport = vi.fn(async () => {
    expect(close).toHaveBeenCalledTimes(1);
  });
  createHost.mockImplementation(
    async (
      _connection: unknown,
      _queue: unknown,
      _workflows: unknown,
      _projects: unknown,
      _profile: unknown,
      hostRoot: string,
    ) => {
      expect(existsSync(join(evidence, 'f01', 'receipt.json'))).toBe(true);
      writeFileSync(
        join(hostRoot, 'host-owner'),
        JSON.stringify({
          pid: process.pid,
          id: 'initial-host',
          tasks: true,
          taskBindings: 2,
        }),
      );
      return {
        async runUntil<T>(work: () => Promise<T>) {
          try {
            return await work();
          } finally {
            close();
          }
        },
      };
    },
  );
  const services = {
    client: {
      workflow: { start },
      connection: { withDeadline: async <T>(_deadline: number, work: () => Promise<T>) => work() },
    } as unknown as Client,
    connection: {} as NativeConnection,
    taskQueue: 'h06-queue',
    workflowsPath: join(root, 'workflows.js'),
    registration,
    profile,
    openProject: vi.fn(async () => {
      expect(existsSync(join(evidence, 'f01', 'receipt.json'))).toBe(true);
      return {
        rpc: { request: vi.fn(), completed: vi.fn() },
        localTasks: { profile, createRuntime: vi.fn() },
        stop: stopTransport,
      };
    }),
    issuer: {
      sessionsRoot: root,
      workspaceRoot: root,
      threadId: 'issuer',
      owner: preparation.owner,
    },
    maxTurnStarts: 4,
    workDeadlineMs: Date.now() + 30000,
  };
  bindTaskBackendClient(services.client, registration);
  return { binding, evidence, input, services, start, close, handle, stopTransport };
}

it.each([2, 3] as const)(
  'retains the actual taskBindings %s owner identity without rewriting its source',
  (taskBindings) => {
    const f = fixture();
    const root = join(f.evidence, 'temporal-host');
    mkdirSync(root);
    const path = join(root, 'host-owner');
    const owner = { pid: process.pid, id: 'current-host', tasks: true, taskBindings };
    writeFileSync(path, JSON.stringify(owner), { mode: 0o600 });
    const before = readFileSync(path);
    expect(readH06NativeHostOwner(root)).toEqual(owner);
    expect(readFileSync(path)).toEqual(before);
  },
);

it('refuses an unsupported taskBindings owner without changing its source identity', () => {
  const f = fixture();
  const root = join(f.evidence, 'temporal-host');
  mkdirSync(root);
  const path = join(root, 'host-owner');
  writeFileSync(
    path,
    JSON.stringify({ pid: process.pid, id: 'current-host', tasks: true, taskBindings: 4 }),
    { mode: 0o600 },
  );
  const before = readFileSync(path);
  expect(() => readH06NativeHostOwner(root)).toThrow('h06-temporal-host-owner');
  expect(readFileSync(path)).toEqual(before);
});

it('binds the native transport to the registered workspace, copy root and work deadline', async () => {
  const f = fixture();
  const { profile, openProject, ...services } = f.services;
  openTransport.mockImplementation(openProject);
  const options = {
    profile,
    binary: f.binding.node,
    evidenceRoot: join(f.evidence, 'transport-initial'),
    disabledServers: [],
    stopDeadlineMs: services.workDeadlineMs + 10000,
    admitTurn: vi.fn(async () => {}),
    recordTurn: vi.fn(async () => {}),
  };
  const stage = h06NativeTemporalServices(services, options);
  expect(openTransport).not.toHaveBeenCalled();
  await startH06NativeTemporal(f.binding, f.evidence, f.input, stage, async () => {});
  expect(openTransport).toHaveBeenCalledExactlyOnceWith({
    ...options,
    operationId: f.binding.operationId,
    workspaceRoot: f.binding.workspaceRoot,
    copyRoot: join(services.registration.artifactRoot, 'copies'),
    workDeadlineMs: services.workDeadlineMs,
  });
  expect(f.stopTransport).toHaveBeenCalledTimes(1);
});

it('closes the transport if the host cannot start', async () => {
  const f = fixture();
  createHost.mockRejectedValueOnce(new Error('Worker startup failed'));
  f.stopTransport.mockResolvedValueOnce(undefined);
  const run = vi.fn();
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, run),
  ).rejects.toThrow('Worker startup failed');
  expect(f.stopTransport).toHaveBeenCalledTimes(1);
  expect(f.start).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it('retains both the stage and cleanup failures', async () => {
  const f = fixture();
  const stage = new Error('Worker startup failed');
  const cleanup = new Error('transport stop unknown');
  createHost.mockRejectedValueOnce(stage);
  f.stopTransport.mockRejectedValueOnce(cleanup);
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, vi.fn()),
  ).rejects.toMatchObject({ errors: [stage, cleanup] });
});

it('leaves the stage unconfirmed when transport cleanup fails', async () => {
  const f = fixture();
  f.stopTransport.mockRejectedValueOnce(new Error('transport stop unknown'));
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, async () => 'finished'),
  ).rejects.toThrow('transport stop unknown');
  expect(f.close).toHaveBeenCalledTimes(1);
});

it('binds the real F-01 to the initial ManagedTaskWorkflow before the next stage', async () => {
  const f = fixture();
  const run: Parameters<typeof startH06NativeTemporal<string>>[4] = async (handle, pin) => {
    expect(handle).toBe(f.handle);
    expect(pin.path).toBe(join(f.evidence, 'temporal-start.json'));
    const receipt = JSON.parse(readH04Pin(pin).toString()) as {
      initialFailure: { path: string; sha256: string };
    };
    expect(receipt).toMatchObject({
      kind: 'h06-native-temporal-start',
      operationId: f.binding.operationId,
      workflowId: f.handle.workflowId,
      firstExecutionRunId: f.handle.firstExecutionRunId,
      taskQueue: f.services.taskQueue,
      hostRoot: join(f.evidence, 'temporal-host'),
      input: f.input,
    });
    expect(checkH06NativeFailure(f.binding, receipt.initialFailure)).toEqual(
      receipt.initialFailure,
    );
    return 'continued';
  };
  const result = await startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, run);
  expect(result.writer).toBe('continued');
  expect(createHost).toHaveBeenCalledTimes(1);
  expect(f.start).toHaveBeenCalledExactlyOnceWith(
    'LocalTaskWorkflow',
    expect.objectContaining({
      args: [f.input],
      taskQueue: f.services.taskQueue,
      workflowId: f.handle.workflowId,
    }),
  );
  expect(f.handle.query).toHaveBeenCalledExactlyOnceWith('localTaskInput');
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.stopTransport).toHaveBeenCalledTimes(1);
});

it.each([
  'variant',
  'attempt',
  'owner',
  'artifact-root',
  'budget',
  'deadline',
  'prior-start',
] as const)('refuses invalid %s before recording F-01 or creating a host', async (which) => {
  const f = fixture();
  if (which === 'variant') f.binding.variant = 'legacy';
  if (which === 'attempt')
    f.input.continuation = { attempt: 1, previous: f.input.admission.planning };
  if (which === 'owner') f.services.issuer.owner = 'foreign';
  if (which === 'artifact-root') f.services.registration.artifactRoot = f.binding.workspaceRoot;
  if (which === 'budget') f.services.maxTurnStarts = 0;
  if (which === 'deadline') f.services.workDeadlineMs = Date.now();
  if (which === 'prior-start') writeFileSync(join(f.evidence, 'temporal-start.json'), '{}');
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, vi.fn()),
  ).rejects.toThrow();
  expect(createHost).not.toHaveBeenCalled();
  expect(f.services.openProject).not.toHaveBeenCalled();
  expect(existsSync(join(f.evidence, 'f01'))).toBe(false);
});

it('retains F-01, stops the host and refuses to continue or repeat after a failed start', async () => {
  const f = fixture();
  f.start.mockRejectedValueOnce(new Error('workflow start not confirmed'));
  const run = vi.fn();
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, run),
  ).rejects.toThrow('workflow start not confirmed');
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(join(f.evidence, 'f01', 'receipt.json'))).toBe(true);
  expect(existsSync(join(f.evidence, 'temporal-start.json'))).toBe(false);
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, run),
  ).rejects.toThrow('h06-temporal-start-not-fresh');
  expect(f.start).toHaveBeenCalledTimes(1);
});

it('keeps the confirmed start receipt when the deadline prevents continuing', async () => {
  const f = fixture();
  const run = vi.fn();
  f.handle.query.mockImplementationOnce(async () => {
    f.services.workDeadlineMs = Date.now();
    return f.input;
  });
  await expect(
    startH06NativeTemporal(f.binding, f.evidence, f.input, f.services, run),
  ).rejects.toThrow('h06-temporal-start-deadline');
  const receipt: unknown = JSON.parse(
    readFileSync(join(f.evidence, 'temporal-start.json'), 'utf8'),
  );
  expect(receipt).toMatchObject({
    workflowId: f.handle.workflowId,
    firstExecutionRunId: f.handle.firstExecutionRunId,
  });
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it('pins the autonomous mode in the start receipt and uses the initial grant authority', async () => {
  const f = fixture(),
    mode = {
      kind: 'temporal-autonomous/3',
      authority: { path: '/parent.json', sha256: '0'.repeat(64) },
    } as const;
  parent.mockReturnValue({});
  await startH06NativeTemporal(
    f.binding,
    f.evidence,
    f.input,
    { ...f.services, controlMode: mode },
    async (_handle, started) => {
      expect(
        (JSON.parse(readH04Pin(started).toString()) as { controlMode: unknown }).controlMode,
      ).toEqual(mode);
    },
  );
});
