import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@temporalio/client';
import type { NativeConnection, WorkerOptions } from '@temporalio/worker';
import { afterEach, expect, it, vi } from 'vitest';
import { digest, privateDirectory } from '../src/adapters/artifacts/files.js';
import { taskFiles } from '../src/adapters/project/taskFiles.js';
import { taskGateBinding } from '../src/adapters/project/taskGate.js';
import { object } from '../src/contracts/project.js';
import { parseLocalTask } from '../src/policy/localTask.js';
import { readerKey, readerTarget } from '../src/policy/readerControl.js';
import type { ScopedReaderInput } from '../src/contracts/reader.js';
import type { ReviewInput, ReviewSnapshot } from '../src/contracts/review.js';
import type { TaskTree } from '../src/contracts/localTask.js';
import type { ReaderControlActivities } from '../src/contracts/readerControl.js';
import { preflightSubstantialTask } from '../src/activities/substantialTask.js';
import { reviewActivities } from '../src/activities/review.js';
import { createReaderHost } from '../src/worker/readerHost.js';
import { substantialTaskFixture } from './temporal/substantialTaskFixture.js';
import {
  assertH06NativeReaderNotBlocked,
  withH06NativeReaderFailure,
} from './comparisonH06NativeReaderFailure.js';

const mock = vi.hoisted(() => ({ start: vi.fn() }));
const worker = vi.hoisted(() => ({
  create: vi.fn<(options: WorkerOptions) => Promise<unknown>>(),
}));
vi.mock('./comparisonH06NativeTemporal.js', () => ({ readH06NativeTemporalStart: mock.start }));
vi.mock('@temporalio/worker', () => ({ Worker: { create: worker.create } }));
afterEach(() => vi.restoreAllMocks());

async function fixture(existingEvidence = false, attempt = 0) {
  const f = substantialTaskFixture();
  const initial = parseLocalTask({
    ...f.substantialInput,
    schemaVersion: 11,
    continuation: { attempt: 0, previous: null },
  });
  if (initial.schemaVersion !== 11) throw new Error('fixture');
  if (existingEvidence)
    initial.admission.planning = f.save({
      ...f.read(initial.admission.planning),
      schemaVersion: 3,
      evidence: [f.save({ kind: 'prior-planning-evidence' })],
      expectedFiles: [],
    });
  const current = parseLocalTask({
    ...initial,
    continuation:
      attempt === 0
        ? initial.continuation
        : {
            attempt,
            previous: f.save({
              kind: 'task-execution-continuation',
              held: f.save({
                kind: 'task-execution-held',
                stopped: f.save({ confirmed: true }),
                progress: { records: [] },
              }),
            }),
          },
  });
  if (current.schemaVersion !== 11) throw new Error('Expected managed fixture');
  const evidence = privateDirectory(join(f.root, 'evidence'));
  const hostRoot = privateDirectory(join(evidence, 'temporal-host'));
  const admissions = privateDirectory(join(hostRoot, 'admissions'));
  const started = { path: join(evidence, 'temporal-start.json'), sha256: '0'.repeat(64) };
  const start = {
    hostRoot,
    workspaceRoot: f.workspace,
    hostOwner: { id: 'owner' },
    profile: f.profile,
  };
  mock.start.mockReturnValue({
    start,
    input: initial,
    workflowId: 'task',
    evidence,
    artifactRoot: f.registration.artifactRoot,
  });
  const gate = taskGateBinding(
    current,
    taskFiles(f.registration.artifactRoot).binding(f.workspace),
    f.profile,
    f.registration.artifactRoot,
    'owner',
  );
  privateDirectory(gate.directory);
  const ready = await preflightSubstantialTask(f.registration, current, f.rpc, f.profile);
  const preflight = f.read(ready.manifest) as {
    kind: string;
    input: typeof initial;
    planning: ReviewInput;
    plan: unknown;
    tree: TaskTree;
  };
  const planning = preflight.planning;
  const preflightPath = join(gate.directory, 'substantial-preflight.json');
  const savePreflight = () => writeFileSync(preflightPath, JSON.stringify(f.save(preflight)));
  savePreflight();
  const selection = await reviewActivities(f.registration, f.rpc, f.profile).prepareReviewPlan(
    planning,
  );
  let reader = selection.decisions[0]!.input!;
  const snapshot = f.read(reader.review) as unknown as ReviewSnapshot;
  const target = readerTarget(reader, readerKey(reader));
  const permit = { sha256: '2'.repeat(64), bytes: 10 };
  const admission = { schemaVersion: 1, target, inputHash: digest(JSON.stringify(reader)), permit };
  let admissionPath = join(admissions, digest(JSON.stringify(target)));
  const saveAdmission = () => {
    rmSync(admissionPath, { force: true });
    admissionPath = join(admissions, digest(JSON.stringify(admission.target)));
    writeFileSync(admissionPath, JSON.stringify(admission));
  };
  saveAdmission();
  const status: Record<string, unknown> = {
    runId: 'main-run',
    phase: 'planning',
    waiting: false,
    attempt,
    requirementsRevision: planning.preparation.revision,
  };
  const observed: Record<string, unknown> = {
    schemaVersion: 1,
    target,
    runId: 'reader-run',
    mode: 'blocked',
    permit,
    error: 'Error: reader-load-invalid-fragment',
  };
  const mainQuery = vi.fn(async () => status);
  const readerQuery = vi.fn(async (name: string) => (name === 'readerInput' ? reader : observed));
  const getHandle = vi.fn((id: string) => ({ query: id === 'task' ? mainQuery : readerQuery }));
  const client = {
    connection: {
      withDeadline: vi.fn((_deadline: number, run: () => Promise<unknown>) => run()),
      withAbortSignal: vi.fn((_signal: AbortSignal, run: () => Promise<unknown>) => run()),
    },
    workflow: { getHandle },
  } as unknown as Client;
  const abort = new AbortController();
  const deadline = Date.now() + 60_000;
  const check = () =>
    assertH06NativeReaderNotBlocked(client, started, 'main-run', deadline, abort.signal);
  return {
    ...f,
    client,
    started,
    evidence,
    admissions,
    start,
    initial,
    preflight,
    planning,
    preflightPath,
    gateDirectory: gate.directory,
    savePreflight,
    snapshot,
    reader,
    setReader: (value: ScopedReaderInput) => {
      reader = value;
    },
    admission,
    saveAdmission,
    admissionPath,
    status,
    observed,
    mainQuery,
    readerQuery,
    getHandle,
    abort,
    deadline,
    check,
  };
}

async function heldFixture() {
  const f = await fixture(false, 2);
  const stopped: Record<string, unknown> = { confirmed: true, input: f.preflight.input };
  Object.assign(f.status, {
    phase: 'waiting-human',
    waiting: true,
    revision: 4,
    error: 'ActivityFailure: Activity task failed',
    stopFailure: '',
    snapshot: f.save({ kind: 'unit-fixture-writing-snapshot' }),
  });
  const held: Record<string, unknown> = {
    kind: 'task-execution-held',
    input: f.preflight.input,
    command: null,
    reason: f.status.error,
    progress: { phase: 'writing', snapshot: f.status.snapshot },
  };
  const stoppedPath = join(f.gateDirectory, 'stopped.json');
  const heldPath = join(f.gateDirectory, 'execution-held.json');
  const saveHeld = () => {
    held.stopped = f.save(stopped);
    writeFileSync(stoppedPath, JSON.stringify(held.stopped));
    f.status.held = f.save(held);
    writeFileSync(heldPath, JSON.stringify(f.status.held));
  };
  saveHeld();
  return { ...f, stopped, held, stoppedPath, heldPath, saveHeld };
}

it('fails promptly on the bound cold Writer error held by the real preflight producer', async () => {
  const f = await heldFixture();
  await expect(f.check()).rejects.toThrow(
    'h06-temporal-task-held: ActivityFailure: Activity task failed',
  );
  expect(f.readerQuery).not.toHaveBeenCalled();
  expect(f.mainQuery).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readFileSync(join(f.evidence, 'task-failure-2.json'), 'utf8'))).toMatchObject({
    kind: 'h06-native-task-held',
    task: { workflowId: 'task', runId: 'main-run', attempt: 2 },
    held: f.status.held,
    error: f.status.error,
  });
});

it.each([
  'phase',
  'waiting',
  'attempt',
  'revision',
  'empty-error',
  'null-error',
  'no-held',
  'command',
  'kind',
  'input',
  'reason',
  'held-index',
  'progress-phase',
  'snapshot',
  'stop-index',
  'unconfirmed-stop',
  'stop-input',
  'missing-held-index',
  'missing-stop-index',
  'missing-preflight',
  'query-unavailable',
] as const)(
  'does not classify unrelated or incomplete cold held evidence as a failure: %s',
  async (kind) => {
    const f = await heldFixture();
    if (kind === 'phase') f.status.phase = 'writing';
    if (kind === 'waiting') f.status.waiting = false;
    if (kind === 'attempt') f.status.attempt = 1;
    if (kind === 'revision') f.status.revision = 3;
    if (kind === 'empty-error') f.status.error = '';
    if (kind === 'null-error') f.status.error = null;
    if (kind === 'command') f.held.command = { revision: 4 };
    if (kind === 'kind') f.held.kind = 'foreign';
    if (kind === 'input') f.held.input = f.initial;
    if (kind === 'reason') f.held.reason = 'foreign';
    if (kind === 'progress-phase') object(f.held.progress).phase = 'checking';
    if (kind === 'snapshot') object(f.held.progress).snapshot = f.save({ foreign: true });
    if (kind === 'unconfirmed-stop') f.stopped.confirmed = false;
    if (kind === 'stop-input') f.stopped.input = f.initial;
    f.saveHeld();
    if (kind === 'no-held') f.status.held = null;
    if (kind === 'held-index') writeFileSync(f.heldPath, JSON.stringify(f.save({ foreign: true })));
    if (kind === 'stop-index')
      writeFileSync(f.stoppedPath, JSON.stringify(f.save({ foreign: true })));
    if (kind === 'missing-held-index') rmSync(f.heldPath);
    if (kind === 'missing-stop-index') rmSync(f.stoppedPath);
    if (kind === 'missing-preflight') rmSync(f.preflightPath);
    if (kind === 'query-unavailable')
      f.mainQuery.mockResolvedValueOnce(f.status).mockRejectedValueOnce(new Error('transient'));
    await expect(f.check()).resolves.toBeUndefined();
    expect(existsSync(join(f.evidence, 'task-failure-2.json'))).toBe(false);
  },
);

it.each([
  'runId',
  'phase',
  'waiting',
  'attempt',
  'requirementsRevision',
  'revision',
  'error',
  'stopFailure',
  'held',
  'snapshot',
] as const)(
  'rechecks the stable cold held binding before publishing a failure: %s',
  async (key) => {
    const f = await heldFixture();
    f.mainQuery.mockResolvedValueOnce(f.status).mockResolvedValueOnce({ ...f.status, [key]: null });
    await expect(f.check()).resolves.toBeUndefined();
    expect(existsSync(join(f.evidence, 'task-failure-2.json'))).toBe(false);
  },
);

it('ignores elapsed time changes while confirming the same cold held failure', async () => {
  const f = await heldFixture();
  f.mainQuery
    .mockResolvedValueOnce({ ...f.status, elapsedMs: 1 })
    .mockResolvedValueOnce({ ...f.status, elapsedMs: 2 });
  await expect(f.check()).rejects.toThrow('h06-temporal-task-held');
});

it.each(['owner', 'previous'] as const)(
  'keeps the actual cold preflight ownership and legal continuation guards: %s',
  async (kind) => {
    const f = await heldFixture();
    if (kind === 'owner') f.preflight.input.admission.preparation.owner = 'foreign';
    else f.preflight.input.continuation.previous = null;
    f.savePreflight();
    await expect(f.check()).rejects.toThrow();
    expect(existsSync(join(f.evidence, 'task-failure-2.json'))).toBe(false);
  },
);

it.each(['progress', 'stopped', 'held-index', 'status-held', 'status-snapshot'] as const)(
  'rejects malformed own cold proof instead of treating it as an observed Writer failure: %s',
  async (kind) => {
    const f = await heldFixture();
    if (kind === 'progress') f.held.progress = null;
    f.saveHeld();
    if (kind === 'stopped') {
      f.held.stopped = null;
      f.status.held = f.save(f.held);
      writeFileSync(f.heldPath, JSON.stringify(f.status.held));
    }
    if (kind === 'held-index') writeFileSync(f.heldPath, '{}');
    if (kind === 'status-held') f.status.held = {};
    if (kind === 'status-snapshot') f.status.snapshot = null;
    await expect(f.check()).rejects.toThrow();
    expect(existsSync(join(f.evidence, 'task-failure-2.json'))).toBe(false);
  },
);

it('preserves the exact blocked LOAD error, admitted Reader and both run IDs before failing', async () => {
  const f = await fixture();
  await expect(f.check()).rejects.toThrow(
    'h06-temporal-reader-blocked: Error: reader-load-invalid-fragment',
  );
  const receipt: unknown = JSON.parse(
    readFileSync(
      join(f.evidence, `reader-failure-0-${digest(JSON.stringify(f.admission.target))}.json`),
      'utf8',
    ),
  );
  expect(receipt).toMatchObject({
    task: { workflowId: 'task', runId: 'main-run', attempt: 0 },
    reader: {
      target: f.admission.target,
      runId: 'reader-run',
      inputHash: f.admission.inputHash,
      permit: f.admission.permit,
    },
    error: f.observed.error,
    status: f.observed,
  });
  expect(f.getHandle).toHaveBeenCalledWith(f.admission.target.workflowId, 'reader-run', {
    followRuns: false,
  });
  expect(f.client.connection.withDeadline).toHaveBeenCalledWith(f.deadline, expect.any(Function));
});

it.each([1, 2])(
  'waits for the real preflight of resumed attempt %i without inventing its input',
  async (attempt) => {
    const f = await fixture();
    f.status.attempt = attempt;
    await expect(f.check()).resolves.toBeUndefined();
    expect(f.readerQuery).not.toHaveBeenCalled();
  },
);

it('observes the actual derived preflight, review input and host-published Reader admission', async () => {
  const f = await fixture();
  expect(f.planning.request).not.toEqual(f.initial.admission.planning);
  const derived = f.read(f.planning.request);
  expect(derived.schemaVersion).toBe(3);
  expect(Array.isArray(derived.expectedFiles)).toBe(true);
  expect(Array.isArray(derived.evidence)).toBe(true);
  worker.create.mockImplementation(async () => {
    let stop!: () => void;
    const ended = new Promise<void>((resolve) => {
      stop = resolve;
    });
    return { run: () => ended, shutdown: () => stop() };
  });
  rmSync(f.admissionPath);
  const host = await createReaderHost(
    {} as NativeConnection,
    'planning-observer',
    'unused-workflows',
    [
      {
        registration: f.registration,
        rpc: f.rpc,
        authority: {
          verify: async () => {
            throw new Error('no human command in this regression');
          },
        },
      },
    ],
    f.profile,
    f.start.hostRoot,
    24,
  );
  const controls = worker.create.mock.calls.at(-2)![0].activities as ReaderControlActivities;
  await host.runUntil(async () => {
    const permit = await controls.registerReader(f.reader, readerKey(f.reader));
    f.observed.permit = permit;
    expect(JSON.parse(readFileSync(f.admissionPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      target: f.admission.target,
      inputHash: f.admission.inputHash,
      permit,
    });
    f.observed.mode = 'running';
    await expect(f.check()).resolves.toBeUndefined();
    f.observed.mode = 'blocked';
    await expect(f.check()).rejects.toThrow(
      'h06-temporal-reader-blocked: Error: reader-load-invalid-fragment',
    );
  });
});

it('retains pre-existing evidence in the real derived planning request', async () => {
  const f = await fixture(true);
  f.observed.mode = 'running';
  await expect(f.check()).resolves.toBeUndefined();
});

it.each([
  'schema',
  'empty-evidence',
  'tree',
  'expected-files',
  'roles',
  'scope',
  'shared-paths',
  'source-evidence',
  'proposal-kind',
  'proposal-input',
  'proposal-plan',
] as const)('rejects a forged derived planning packet: %s', async (kind) => {
  const f = await fixture(kind === 'source-evidence');
  const request = f.read(f.planning.request);
  if (kind === 'schema') request.schemaVersion = 2;
  if (kind === 'empty-evidence') request.evidence = [];
  if (kind === 'tree') Object.assign(f.preflight.tree, { files: null });
  if (kind === 'expected-files') request.expectedFiles = [];
  if (kind === 'roles') (request.roles as { reason: string }[])[0]!.reason = 'a foreign selection';
  if (kind === 'scope') request.scope = 'foreign';
  if (kind === 'shared-paths') request.sharedPaths = [];
  const evidence = request.evidence as { sha256: string; bytes: number }[];
  if (kind === 'source-evidence') evidence[0] = f.save({ kind: 'foreign-evidence' });
  if (kind.startsWith('proposal-')) {
    const proposal = f.read(evidence.at(-1)!);
    if (kind === 'proposal-kind') proposal.kind = 'foreign';
    if (kind === 'proposal-input') proposal.input = { ...f.initial, baseline: 'foreign' };
    if (kind === 'proposal-plan') proposal.plan = {};
    evidence[evidence.length - 1] = f.save(proposal);
  }
  f.planning.request = f.save(request);
  f.savePreflight();
  await expect(f.check()).rejects.toThrow('h06-temporal-reader-planning');
});

it.each([
  'running',
  'answered',
  'null-error',
  'empty-error',
  'unrelated-project',
  'unrelated-task',
  'old-scope',
  'unscoped',
  'reader-query-unavailable',
  'status-query-unavailable',
  'changed-status',
  'confirmed-unavailable',
  'changed-main',
  'main-unavailable',
  'missing-preflight',
  'missing-admissions',
  'pending-publication',
  'not-planning',
  'waiting',
  'main-query-unavailable',
] as const)(
  'does not mistake incomplete or unrelated observations for an accepted failure: %s',
  async (kind) => {
    const f = await fixture();
    if (kind === 'running' || kind === 'answered') f.observed.mode = kind;
    if (kind === 'null-error') f.observed.error = null;
    if (kind === 'empty-error') f.observed.error = '';
    if (kind === 'unrelated-project') f.admission.target.projectId = 'another';
    if (kind === 'unrelated-task') f.admission.target.taskId = 'another';
    if (kind === 'unrelated-project' || kind === 'unrelated-task') f.saveAdmission();
    if (kind === 'old-scope') {
      const reader = { ...f.reader, reviewId: '3'.repeat(64) };
      f.setReader(reader);
      f.admission.target = readerTarget(reader, readerKey(reader));
      f.observed.target = f.admission.target;
      f.admission.inputHash = digest(JSON.stringify(reader));
      f.saveAdmission();
    }
    if (kind === 'unscoped') {
      const reader = { preparation: f.reader.preparation, roleId: f.reader.roleId };
      f.readerQuery.mockImplementation(async (name) =>
        name === 'readerInput' ? reader : f.observed,
      );
      f.admission.target = readerTarget(reader, readerKey(reader));
      f.observed.target = f.admission.target;
      f.admission.inputHash = digest(JSON.stringify(reader));
      f.saveAdmission();
    }
    if (kind === 'reader-query-unavailable')
      f.readerQuery.mockImplementation(async (name) => {
        if (name === 'readerInput') throw new Error('transient');
        return f.observed;
      });
    if (kind === 'status-query-unavailable')
      f.readerQuery.mockRejectedValue(new Error('transient'));
    if (kind === 'changed-status')
      f.readerQuery
        .mockResolvedValueOnce(f.observed)
        .mockResolvedValueOnce(f.reader)
        .mockResolvedValueOnce({ ...f.observed, mode: 'answered' });
    if (kind === 'confirmed-unavailable')
      f.readerQuery
        .mockResolvedValueOnce(f.observed)
        .mockResolvedValueOnce(f.reader)
        .mockRejectedValueOnce(new Error('transient'));
    if (kind === 'changed-main')
      f.mainQuery
        .mockResolvedValueOnce(f.status)
        .mockResolvedValueOnce({ ...f.status, phase: 'writing' });
    if (kind === 'main-unavailable')
      f.mainQuery.mockResolvedValueOnce(f.status).mockRejectedValueOnce(new Error('transient'));
    if (kind === 'missing-preflight') rmSync(f.preflightPath);
    if (kind === 'missing-admissions') rmSync(f.admissions, { recursive: true });
    if (kind === 'pending-publication') {
      rmSync(f.admissionPath);
      writeFileSync(join(f.admissions, '.pending-publication'), 'incomplete');
    }
    if (kind === 'not-planning') f.status.phase = 'done';
    if (kind === 'waiting') f.status.waiting = true;
    if (kind === 'main-query-unavailable') f.mainQuery.mockRejectedValue(new Error('transient'));
    await expect(f.check()).resolves.toBeUndefined();
    expect(
      existsSync(
        join(f.evidence, `reader-failure-0-${digest(JSON.stringify(f.admission.target))}.json`),
      ),
    ).toBe(false);
  },
);

it.each([
  'host',
  'main-run',
  'attempt',
  'preflight-kind',
  'preflight-schema',
  'preflight-task',
  'preflight-attempt',
  'preflight-revision',
  'preflight-preparation',
  'preflight-plan',
  'planning-preparation',
  'planning-request',
  'planning-phase',
  'admission-schema',
  'admission-name',
  'input-hash',
  'foreign-preparation',
  'status-schema',
  'status-target',
  'permit',
  'reader-preparation',
  'confirmed-main-run',
  'confirmed-schema',
  'confirmed-target',
  'confirmed-run',
  'confirmed-permit',
] as const)('rejects contradictory ownership or immutable bindings: %s', async (kind) => {
  const f = await fixture();
  if (kind === 'host') f.start.hostRoot += '-foreign';
  if (kind === 'main-run') f.status.runId = 'foreign';
  if (kind === 'attempt') f.status.attempt = -1;
  if (kind === 'preflight-kind') f.preflight.kind = 'foreign';
  if (kind === 'preflight-schema') Object.assign(f.preflight.input, { schemaVersion: 10 });
  if (kind === 'preflight-task') f.preflight.input.admission.preparation.taskId = 'foreign';
  if (kind === 'preflight-attempt') f.preflight.input.continuation.attempt = 1;
  if (kind === 'preflight-revision') f.status.requirementsRevision = 100;
  if (kind === 'preflight-preparation') f.preflight.input.admission.preparation.owner = 'foreign';
  if (kind === 'preflight-plan')
    f.preflight.input.admission.plan = { path: 'another.json', sha256: '4'.repeat(64) };
  if (kind === 'planning-preparation')
    f.planning.preparation = { ...f.planning.preparation, owner: 'foreign' };
  if (kind === 'planning-request') f.planning.request = f.save({ kind: 'foreign' });
  if (kind === 'planning-phase') {
    f.planning.request = f.save({ ...f.request, phase: 'acceptance' });
    f.preflight.input.admission.planning = f.planning.request;
  }
  f.savePreflight();
  if (kind === 'admission-schema') f.admission.schemaVersion = 2;
  if (kind === 'admission-name') {
    f.admission.target.roleId = 'tester';
  }
  if (kind === 'input-hash') f.admission.inputHash = '4'.repeat(64);
  if (kind === 'foreign-preparation' || kind === 'reader-preparation') {
    const reader = {
      ...f.reader,
      preparation: {
        ...f.reader.preparation,
        ...(kind === 'foreign-preparation' ? { owner: 'foreign' } : { revision: 100 }),
      },
    };
    f.setReader(reader);
    f.admission.target = readerTarget(reader, readerKey(reader));
    f.observed.target = f.admission.target;
    f.admission.inputHash = digest(JSON.stringify(reader));
  }
  if (kind === 'status-schema') f.observed.schemaVersion = 2;
  if (kind === 'status-target') f.observed.target = { ...f.admission.target, owner: 'foreign' };
  if (kind === 'permit') f.observed.permit = { sha256: '4'.repeat(64), bytes: 10 };
  if (kind === 'confirmed-main-run')
    f.mainQuery
      .mockResolvedValueOnce(f.status)
      .mockResolvedValueOnce({ ...f.status, runId: 'foreign' });
  if (kind.startsWith('confirmed-') && kind !== 'confirmed-main-run') {
    const confirmed = {
      ...f.observed,
      ...(kind === 'confirmed-schema'
        ? { schemaVersion: 2 }
        : kind === 'confirmed-target'
          ? { target: { ...f.admission.target, owner: 'foreign' } }
          : kind === 'confirmed-run'
            ? { runId: 'foreign' }
            : { permit: { sha256: '4'.repeat(64), bytes: 10 } }),
    };
    f.readerQuery
      .mockResolvedValueOnce(f.observed)
      .mockResolvedValueOnce(f.reader)
      .mockResolvedValueOnce(confirmed);
  }
  if (kind === 'admission-name') writeFileSync(f.admissionPath, JSON.stringify(f.admission));
  else f.saveAdmission();
  await expect(f.check()).rejects.toThrow();
});

it('keeps the original absolute deadline on abort and transient query errors', async () => {
  const f = await fixture();
  await expect(
    assertH06NativeReaderNotBlocked(f.client, f.started, 'main-run', 1, f.abort.signal),
  ).rejects.toThrow('h06-temporal-reader-deadline');
  f.readerQuery.mockImplementation(async () => {
    f.abort.abort(new Error('stopped'));
    throw new Error('transient');
  });
  await expect(f.check()).rejects.toThrow('stopped');
});

it('does not renew the work deadline after a transient query failure', async () => {
  const f = await fixture();
  f.mainQuery.mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(f.deadline);
    throw new Error('transient');
  });
  await expect(f.check()).rejects.toThrow('h06-temporal-reader-deadline');
  expect(f.getHandle).toHaveBeenCalledOnce();
});

it('aborts an in-flight SDK query and joins it when the main result arrives', async () => {
  const f = await fixture();
  let querySignal: AbortSignal | undefined;
  let queryFinished = false;
  f.client.connection.withAbortSignal = <T>(signal: AbortSignal, run: () => Promise<T>) => {
    querySignal = signal;
    return run();
  };
  f.mainQuery.mockImplementation(
    () =>
      new Promise((_, reject) => {
        querySignal!.addEventListener(
          'abort',
          () => {
            queryFinished = true;
            reject(querySignal!.reason);
          },
          { once: true },
        );
      }),
  );
  await expect(
    withH06NativeReaderFailure(
      f.client,
      f.started,
      'main-run',
      f.deadline,
      f.abort.signal,
      async () => 'done',
    ),
  ).resolves.toBe('done');
  expect(queryFinished).toBe(true);
  expect(querySignal!.aborted).toBe(true);
  expect(f.getHandle).toHaveBeenCalledOnce();
});

it.each(['phase', 'scope', 'selection'] as const)(
  'rejects a Reader snapshot outside the active planning packet: %s',
  async (kind) => {
    const f = await fixture();
    const snapshot = {
      ...f.snapshot,
      ...(kind === 'phase'
        ? { phase: 'acceptance' }
        : kind === 'scope'
          ? { scope: 'foreign' }
          : { selection: { ...f.snapshot.selection, reason: 'foreign' } }),
    };
    const reader = { ...f.reader, review: f.save(snapshot) };
    f.setReader(reader);
    f.admission.inputHash = digest(JSON.stringify(reader));
    f.saveAdmission();
    await expect(f.check()).rejects.toThrow('h06-temporal-reader-review');
  },
);

it.each(['result', 'failure', 'abort', 'blocked', 'held'] as const)(
  'joins the observer and leaves no query after %s',
  async (kind) => {
    const f = kind === 'held' ? await heldFixture() : await fixture();
    if (kind !== 'blocked' && kind !== 'held') f.status.phase = 'writing';
    const run = vi.fn(async () => {
      if (kind === 'failure') throw new Error('result failed');
      if (kind === 'abort') {
        f.abort.abort(new Error('cancelled'));
        throw f.abort.signal.reason;
      }
      if (kind === 'blocked' || kind === 'held') return new Promise<never>(() => {});
      return 'done';
    });
    const result = withH06NativeReaderFailure(
      f.client,
      f.started,
      'main-run',
      f.deadline,
      f.abort.signal,
      run,
    );
    if (kind === 'result') await expect(result).resolves.toBe('done');
    else
      await expect(result).rejects.toThrow(
        kind === 'failure'
          ? 'result failed'
          : kind === 'abort'
            ? 'cancelled'
            : kind === 'held'
              ? 'h06-temporal-task-held'
              : 'reader-load-invalid-fragment',
      );
    const queries = f.getHandle.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(f.getHandle).toHaveBeenCalledTimes(queries);
    expect(run).toHaveBeenCalledOnce();
  },
);
