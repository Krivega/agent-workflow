import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type { ArtifactRef, LocalProjectRegistration } from '../../src/contracts/preparation.js';
import type {
  VerifiedStartAdmission,
  TaskStartAdmission,
} from '../../src/contracts/taskStartAdmission.js';
import type {
  TaskHumanCommand,
  TaskHumanCommandContext,
  TaskHumanExecutionCheckpoint,
  TaskHumanFinishRequest,
  TaskHumanTechnicalCompletion,
} from '../../src/contracts/taskHuman.js';
import { artifactStore, digest, privateDirectory } from '../../src/adapters/artifacts/files.js';
import * as artifactFiles from '../../src/adapters/artifacts/files.js';
import { taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import {
  taskHumanActivities,
  type TaskHumanActivityPorts,
} from '../../src/activities/taskHuman.js';
import { localTaskKey, parseLocalTask } from '../../src/policy/localTask.js';
import {
  applyTaskHumanCommand,
  advanceTaskHumanRequirements,
  closeTaskHuman,
  createTaskHumanState,
  taskHumanCanonical,
  taskHumanCommandText,
} from '../../src/policy/taskHuman.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { object, requireContract } from '../../src/contracts/project.js';

const native = vi.hoisted(() => ({
  info: {} as Record<string, unknown>,
  signal: new AbortController().signal,
  available: true,
}));
vi.mock('@temporalio/activity', () => ({
  Context: {
    current() {
      if (!native.available) throw new Error('No Activity context');
      return { info: native.info, cancellationSignal: native.signal };
    },
  },
}));
const roots: string[] = [];
beforeEach(() => {
  native.available = true;
  native.signal = new AbortController().signal;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(human = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-human-activities-')));
  roots.push(root);
  const workspaceRoot = privateDirectory(join(root, 'workspace')),
    artifactRoot = privateDirectory(join(root, 'artifacts'));
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  const store = artifactStore(artifactRoot, { existingOnly: true });
  const save = (body: unknown) => store.publish(Buffer.from(taskHumanCanonical(body)));
  const ref = save({ kind: 'technical-fixture-reference' });
  const raw = {
    schemaVersion: 12,
    startAdmission: ref,
    admission: {
      schemaVersion: 3,
      preparation: {
        schemaVersion: 1,
        project: {
          schemaVersion: 1,
          projectId: 'project',
          workspaceId: 'workspace',
          rules: ['rule.md'],
          cardRoot: 'tasks',
          roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
          checks: ['check'],
        },
        taskId: 'task',
        hostId: 'host',
        owner: 'owner',
        generation: 1,
        revision: 1,
        card: 'tasks/task.md',
      },
      plan: { path: 'plan.json', sha256: ref.sha256 },
      planning: ref,
      acceptance: ref,
    },
    executor: { path: 'writer.md', sha256: ref.sha256 },
    baseline: 'check',
    continuation: { attempt: 0, previous: null },
  };
  const parsed = parseLocalTask(raw);
  requireContract(parsed.schemaVersion === 12, 'fixture-input');
  const input: HumanManagedTaskInput = parsed;
  const registration: LocalProjectRegistration = {
    project: input.admission.preparation.project,
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    workspaceRoot,
    artifactRoot,
    commands: {},
  };
  native.info = {
    isLocal: false,
    workflowType: 'LocalTaskWorkflow',
    workflowExecution: { workflowId: localTaskKey(input), runId: 'run-one' },
    activityId: 'activity',
    activityType: 'prepareTaskHuman',
    taskQueue: 'test.control',
    namespace: 'default',
  };
  const declarations = new Map<string, VerifiedStartAdmission>();
  function declare(current: HumanManagedTaskInput, previous: VerifiedStartAdmission | null = null) {
    const admission: TaskStartAdmission = {
      schemaVersion: 1,
      kind: 'task-start-admission',
      previous: previous?.ref ?? null,
      target: { ...taskControlTarget(current), roleId: 'task' },
      card: { path: current.admission.preparation.card, ...ref },
      requirements: ref,
      principal: {
        owner: 'owner',
        threadId: 'synthetic-thread',
        turnId: 'synthetic-turn',
        source: { locator: '/synthetic/native.jsonl#L1', hash: ref.sha256 },
        proof: ref,
      },
      criteria: human
        ? [
            {
              id: 'C1: результат проверен',
              text: 'Проверить результат',
              kind: 'human',
              applicable: true,
              reason: 'Declared by fixture owner',
            },
          ]
        : [],
    };
    const declarationRef = save(admission),
      manifest = {
        schemaVersion: 1 as const,
        kind: 'task-human-gate-manifest' as const,
        target: admission.target,
        card: admission.card,
        requirements: admission.requirements,
        declaration: declarationRef,
        criteria: admission.criteria,
      };
    const bound = { manifest, ref: save(manifest) },
      verified: VerifiedStartAdmission = {
        ref: declarationRef,
        admission,
        initial: previous?.initial ?? { ref: declarationRef, admission },
        manifest: bound,
      };
    declarations.set(declarationRef.sha256, verified);
    return verified;
  }
  const initial = declare(input);
  input.startAdmission = initial.ref;
  const stopped = save({ confirmed: true, input });
  const technical: TaskHumanTechnicalCompletion = {
    input,
    snapshot: ref,
    packet: {
      schemaVersion: 1,
      preparation: input.admission.preparation,
      reviewId: 'acceptance',
      request: ref,
    },
    acceptance: ref,
    records: [ref],
    stopped,
  };
  const sources = new Map<string, ArtifactRef>();
  let budget = { limit: 20, used: 4, manifest: ref },
    effects = 0;
  const seals = new Set<string>();
  const declaration = vi.fn<TaskHumanActivityPorts['declaration']>(async (current, card) => {
    const found = declarations.get(current.startAdmission.sha256);
    requireContract(
      found !== undefined && current.startAdmission.bytes === found.ref.bytes,
      'fixture-unregistered-declaration',
    );
    requireContract(
      taskHumanCanonical(taskControlTarget(current)) === taskHumanCanonical(found.admission.target),
      'fixture-registration-binding',
    );
    expect(card).toBe('retained');
    return structuredClone(found);
  });
  const authority = {
    verify: vi.fn<NonNullable<TaskHumanActivityPorts['authority']>['verify']>(
      async (_context, command) => {
        const proof = sources.get(command.source.sha256);
        requireContract(proof !== undefined, 'fixture-primary-source-required');
        store.read(command.source);
        return command.action === 'ASK'
          ? { kind: 'verified-task-human-command', action: 'ASK', command, proof }
          : {
              kind: 'verified-task-human-command',
              action: 'DECIDE',
              command,
              accepted: command.accepted,
              proof,
            };
      },
    ),
  };
  const ports: TaskHumanActivityPorts = {
    taskQueue: 'test.control',
    namespace: 'default',
    authority,
    declaration,
    technical: vi.fn<TaskHumanActivityPorts['technical']>(async (value) => {
      expect(declarations.has(value.input.startAdmission.sha256)).toBe(true);
      const stop = JSON.parse(store.read(value.stopped).toString()) as {
        confirmed: boolean;
        input: unknown;
      };
      requireContract(
        stop.confirmed && taskHumanCanonical(stop.input) === taskHumanCanonical(value.input),
        'fixture-stop-unconfirmed',
      );
    }),
    finish: vi.fn<TaskHumanActivityPorts['finish']>(async (_request, seal) => {
      store.read(seal);
      if (!seals.has(seal.sha256)) {
        seals.add(seal.sha256);
        effects++;
      }
      return { status: 'done', result: ref, projection: ref };
    }),
    control: vi.fn<TaskHumanActivityPorts['control']>(async (context, command, revision) => ({
      input: context.input,
      ack: {
        commandId: command.commandId,
        hash: command.hash,
        revision: revision + 1,
        authorization: ref,
      },
    })),
    budget: vi.fn(async () => budget),
  };
  const service = taskHumanActivities(registration, ports);
  let context: TaskHumanCommandContext = {
    input,
    state: createTaskHumanState(initial.manifest),
    technical,
  };
  const at = (method: string) => {
    native.info.activityType = method;
  };
  function command(action: 'ASK' | 'DECIDE', accepted = true): TaskHumanCommand {
    const source = save({
      kind: 'synthetic-node-authority-source',
      ordinal: context.state.revision,
    });
    sources.set(source.sha256, save({ kind: 'synthetic-node-authority-proof', source }));
    const fields = {
      schemaVersion: 1 as const,
      commandId: action + context.state.revision,
      hash: ref.sha256,
      target: context.state.current.manifest.target,
      manifest: context.state.current.ref,
      expectedRevision: context.state.revision,
      author: 'owner',
      source,
      questionId: context.state.pending?.questionId ?? 'question' + context.state.revision,
      criterionId: 'C1: результат проверен',
    };
    const value = action === 'ASK' ? { ...fields, action } : { ...fields, action, accepted };
    return { ...value, hash: digest(taskHumanCommandText(value)) };
  }
  async function apply(action: 'ASK' | 'DECIDE', accepted = true) {
    const value = command(action, accepted);
    at('verifyTaskHumanCommand');
    const verified = await service.verifyTaskHumanCommand(context, value);
    context = { ...context, state: applyTaskHumanCommand(context.state, value, verified).state };
    return { command: value, verified };
  }
  function request(): TaskHumanFinishRequest {
    return {
      schemaVersion: 1,
      kind: 'task-human-finish',
      ...context,
      state: closeTaskHuman(context.state, context.state.revision),
      expectedRevision: context.state.revision,
    };
  }
  function checkpoint(): TaskHumanExecutionCheckpoint {
    return {
      schemaVersion: 2,
      producer: { workflowId: localTaskKey(input), runId: 'run-one' },
      initial: input,
      input,
      revision: 0,
      history: [ref],
      commands: [],
      previous: null,
      budget,
      beganAt: 42,
      diagnostics: [],
      humanState: context.state,
      technical,
      wait: { kind: 'human-gates', paused: true },
    };
  }
  return {
    root,
    registration,
    store,
    save,
    ref,
    input,
    initial,
    technical,
    service,
    ports,
    authority,
    declaration,
    sources,
    declare,
    declarations,
    at,
    command,
    apply,
    request,
    checkpoint,
    context: () => context,
    setContext: (value: TaskHumanCommandContext) => {
      context = value;
    },
    setBudget: (value: typeof budget) => {
      budget = value;
    },
    effects: () => effects,
    artifactCount: () => readdirSync(artifactRoot).length,
    location: (kind: string, name: string) =>
      join(
        taskBackendHome(workspaceRoot),
        'tasks',
        digest(localTaskKey(input)),
        'human-' + kind,
        name + '.json',
      ),
  };
}

it('requires the actual remote Activity owner before declaration reads or effects', async () => {
  const f = fixture(false),
    request = f.request();
  const valid = structuredClone(native.info);
  for (const patch of [
    { isLocal: true },
    { workflowType: 'OtherWorkflow' },
    { workflowExecution: { workflowId: 'foreign', runId: 'run-one' } },
    { workflowExecution: { workflowId: localTaskKey(f.input), runId: '' } },
    { activityType: 'finishLocalTask' },
    { taskQueue: 'other' },
    { namespace: 'other' },
  ]) {
    native.info = { ...valid, activityType: 'finishTaskHuman', ...patch };
    await expect(f.service.finishTaskHuman(request)).rejects.toThrow(
      'human-activity-owner-unconfirmed',
    );
  }
  native.info = { ...valid, activityType: 'finishTaskHuman' };
  native.available = false;
  await expect(f.service.finishTaskHuman(request)).rejects.toThrow('No Activity context');
  native.available = true;
  const controller = new AbortController();
  controller.abort();
  native.signal = controller.signal;
  await expect(f.service.finishTaskHuman(request)).rejects.toThrow();
  expect(f.declaration).not.toHaveBeenCalled();
  expect(f.effects()).toBe(0);
});
it('uses retained immutable declaration bytes and refuses incomplete manifests or unavailable human authority', async () => {
  const f = fixture();
  f.at('prepareTaskHuman');
  expect(await f.service.prepareTaskHuman(f.input)).toEqual(f.initial.manifest);
  const { startAdmission: ignored, ...legacy } = f.input;
  void ignored;
  await expect(
    f.service.prepareTaskHuman({
      ...legacy,
      schemaVersion: 11,
    } as unknown as HumanManagedTaskInput),
  ).rejects.toThrow('human-input-required');
  f.declaration.mockResolvedValueOnce({ ...f.initial, ref: f.ref });
  await expect(f.service.prepareTaskHuman(f.input)).rejects.toThrow(
    'human-start-admission-binding',
  );
  const bad = { ...f.initial.manifest, manifest: { ...f.initial.manifest.manifest, criteria: [] } };
  f.declaration.mockResolvedValueOnce({ ...f.initial, manifest: bad });
  await expect(f.service.prepareTaskHuman(f.input)).rejects.toThrow('human-manifest-bytes');
  const ports = { ...f.ports };
  delete ports.authority;
  const service = taskHumanActivities(f.registration, ports);
  await expect(service.prepareTaskHuman(f.input)).rejects.toThrow('human-authority-required');
  await expect(f.service.prepareTaskHuman({ ...f.input, startAdmission: f.ref })).rejects.toThrow(
    'fixture-unregistered-declaration',
  );
  expect(f.effects()).toBe(0);
});
it('does not turn declared human gates into consent, rejects forged state and keeps false/pending blocked', async () => {
  const f = fixture();
  f.at('finishTaskHuman');
  await expect(
    f.service.finishTaskHuman({
      schemaVersion: 1,
      kind: 'task-human-finish',
      ...f.context(),
      state: { ...f.context().state, closed: true },
      expectedRevision: 0,
    }),
  ).rejects.toThrow('human-gates-open');
  await f.apply('ASK');
  f.at('finishTaskHuman');
  await expect(
    f.service.finishTaskHuman({
      schemaVersion: 1,
      kind: 'task-human-finish',
      ...f.context(),
      state: { ...f.context().state, closed: true },
      expectedRevision: 1,
    }),
  ).rejects.toThrow('human-gates-open');
  await f.apply('DECIDE', false);
  f.at('finishTaskHuman');
  await expect(
    f.service.finishTaskHuman({
      schemaVersion: 1,
      kind: 'task-human-finish',
      ...f.context(),
      state: { ...f.context().state, closed: true },
      expectedRevision: 2,
    }),
  ).rejects.toThrow('human-gates-open');
  const forged = {
    ...f.context(),
    state: {
      ...f.context().state,
      decisions: [{ ...f.context().state.decisions[0]!, accepted: true }],
    },
  };
  f.at('verifyTaskHumanCommand');
  await expect(f.service.verifyTaskHumanCommand(forged, f.command('ASK'))).rejects.toThrow(
    'human-history-state',
  );
  expect(f.effects()).toBe(0);
});
it('re-verifies original ASK/DECIDE contexts, seals once and reuses the exact completion request', async () => {
  const f = fixture();
  const ask = await f.apply('ASK');
  await f.apply('DECIDE');
  const request = f.request();
  f.at('finishTaskHuman');
  expect(await f.service.finishTaskHuman(request)).toMatchObject({ status: 'done' });
  const count = f.artifactCount();
  expect(f.ports.finish).toHaveBeenCalledOnce();
  expect(await f.service.finishTaskHuman(request)).toMatchObject({ status: 'done' });
  expect(f.artifactCount()).toBe(count);
  expect(f.effects()).toBe(1);
  expect(vi.mocked(f.ports.finish).mock.calls[0]![1]).toEqual(
    vi.mocked(f.ports.finish).mock.calls[1]![1],
  );
  expect(
    f.authority.verify.mock.calls.some(
      ([context, command]) =>
        context.state.revision === 0 &&
        context.state.pending === null &&
        taskHumanCanonical(command) === taskHumanCanonical(ask.command),
    ),
  ).toBe(true);
  const seal = vi.mocked(f.ports.finish).mock.calls[0]![1];
  expect(JSON.parse(f.store.read(seal).toString())).toMatchObject({
    kind: 'task-human-completion-seal',
    producer: {
      activityType: 'finishTaskHuman',
      workflowId: localTaskKey(f.input),
      runId: 'run-one',
    },
  });
  await expect(
    f.service.finishTaskHuman({
      ...request,
      technical: { ...request.technical, records: [...request.technical.records, f.ref] },
    }),
  ).rejects.toThrow('human-completion-conflict');
  await expect(f.service.finishTaskHuman({ ...request, expectedRevision: 0 })).rejects.toThrow(
    'human-finish-request',
  );
});
it('allows explicit empty declarations to finish but does not create human authority from technical Review PASS', async () => {
  const f = fixture(false),
    ports = { ...f.ports };
  delete ports.authority;
  const service = taskHumanActivities(f.registration, ports);
  f.at('finishTaskHuman');
  expect(await service.finishTaskHuman(f.request())).toMatchObject({ status: 'done' });
  expect(f.authority.verify).not.toHaveBeenCalled();
  expect(f.effects()).toBe(1);
});
it('rechecks Activity cancellation after awaited technical validation before sealing or projecting', async () => {
  const f = fixture(false),
    abort = new AbortController();
  native.signal = abort.signal;
  vi.mocked(f.ports.technical).mockImplementationOnce(async () => {
    abort.abort();
  });
  f.at('finishTaskHuman');
  const artifacts = f.artifactCount();
  await expect(f.service.finishTaskHuman(f.request())).rejects.toThrow();
  expect(f.effects()).toBe(0);
  expect(f.artifactCount()).toBe(artifacts);
});
it.each(['command', 'technical', 'last declaration', 'checkpoint'] as const)(
  'rejects a mutated %s witness after awaited verification',
  async (where) => {
    const f = fixture(where === 'command');
    if (where === 'command') {
      const value = f.command('ASK'),
        verify = f.authority.verify.getMockImplementation()!;
      f.authority.verify.mockImplementationOnce(async (context, command) => {
        context.technical.records.push(f.ref);
        return verify(context, command);
      });
      f.at('verifyTaskHumanCommand');
      const count = f.artifactCount();
      await expect(f.service.verifyTaskHumanCommand(f.context(), value)).rejects.toThrow(
        'human-verification-stale',
      );
      expect(f.artifactCount()).toBe(count);
    } else if (where === 'checkpoint') {
      const value = f.checkpoint();
      vi.mocked(f.ports.budget).mockImplementationOnce(async () => {
        value.diagnostics.push({ phase: 'changed', error: 'while awaiting budget' });
        return value.budget;
      });
      f.at('saveTaskHumanCheckpoint');
      const count = f.artifactCount();
      await expect(f.service.saveTaskHumanCheckpoint(value)).rejects.toThrow(
        'human-verification-stale',
      );
      expect(f.artifactCount()).toBe(count);
    } else {
      const request = f.request();
      if (where === 'technical')
        vi.mocked(f.ports.technical).mockImplementationOnce(async () => {
          request.technical.records.push(f.ref);
        });
      else {
        const declaration = f.declaration.getMockImplementation()!;
        let reads = 0;
        f.declaration.mockImplementation(async (...args) => {
          const result = await declaration(...args);
          if (++reads === 2) request.technical.records.push(f.ref);
          return result;
        });
      }
      f.at('finishTaskHuman');
      await expect(f.service.finishTaskHuman(request)).rejects.toThrow('human-verification-stale');
    }
    expect(f.effects()).toBe(0);
  },
);
it('rejects state, technical, proof and native-source drift before control or completion effects', async () => {
  const f = fixture();
  f.at('verifyTaskHumanCommand');
  await expect(
    f.service.verifyTaskHumanCommand(
      {
        ...f.context(),
        state: { ...f.context().state, current: { ...f.initial.manifest, ref: f.ref } },
      },
      f.command('ASK'),
    ),
  ).rejects.toThrow('human-state-manifest');
  await expect(
    f.service.verifyTaskHumanCommand(
      { ...f.context(), state: { ...f.context().state, revision: 1 } },
      f.command('ASK'),
    ),
  ).rejects.toThrow('human-state-invalid');
  await expect(
    f.service.verifyTaskHumanCommand(
      { ...f.context(), technical: { ...f.technical, input: { ...f.input, baseline: 'other' } } },
      f.command('ASK'),
    ),
  ).rejects.toThrow('human-technical-input');
  await expect(
    f.service.verifyTaskHumanCommand(f.context(), { ...f.command('ASK'), hash: f.ref.sha256 }),
  ).rejects.toThrow('human-command-hash');
  const asked = await f.apply('ASK');
  const changed = f.save({ kind: 'changed-native-proof' });
  f.sources.set(asked.command.source.sha256, changed);
  f.at('verifyTaskHumanCommand');
  await expect(f.service.verifyTaskHumanCommand(f.context(), f.command('DECIDE'))).rejects.toThrow(
    'human-command-source-changed',
  );
  expect(f.effects()).toBe(0);
  expect(f.ports.control).not.toHaveBeenCalled();
});
it('rejects altered history receipts, original contexts and recorded Activity producers', async () => {
  const f = fixture(),
    asked = await f.apply('ASK');
  const base = f.context(),
    row = base.state.history[0]!;
  requireContract(row.kind === 'command', 'fixture-history');
  const original = object(JSON.parse(f.store.read(row.receipt.proof).toString()));
  f.at('verifyTaskHumanCommand');
  for (const [proof, error] of [
    [{ ...original, kind: 'caller-json' }, 'human-command-proof-binding'],
    [
      { ...original, command: { ...asked.command, questionId: 'foreign' } },
      'human-command-proof-binding',
    ],
    [
      { ...original, context: { ...base, state: { ...base.state, revision: 0 } } },
      'human-command-proof-binding',
    ],
    [
      { ...original, producer: { ...object(original.producer), activityType: 'finishLocalTask' } },
      'human-recorded-producer',
    ],
    [{ ...original, authority: f.ref }, 'human-command-source-changed'],
  ] as const) {
    const changed = { ...row, receipt: { ...row.receipt, proof: f.save(proof) } };
    await expect(
      f.service.verifyTaskHumanCommand(
        { ...base, state: { ...base.state, history: [changed] } },
        f.command('DECIDE'),
      ),
    ).rejects.toThrow(error);
  }
  for (const [receipt, error] of [
    [{ ...row.receipt, revision: 5 }, 'human-history-revision'],
    [{ ...row.receipt, hash: f.ref.sha256 }, 'human-history-receipt'],
  ] as const) {
    await expect(
      f.service.verifyTaskHumanCommand(
        { ...base, state: { ...base.state, history: [{ ...row, receipt }] } },
        f.command('DECIDE'),
      ),
    ).rejects.toThrow(error);
  }
  expect(f.effects()).toBe(0);
});
it('passes control to the existing source authority only after full retained state and stop verification', async () => {
  const f = fixture(),
    command = {
      schemaVersion: 2 as const,
      commandId: 'pause',
      hash: f.ref.sha256,
      action: 'pause' as const,
      target: taskControlTarget(f.input),
      expectedRevision: 0,
      attempt: 0,
      author: 'owner',
      source: f.ref,
      payload: f.ref,
    };
  f.at('controlTaskHumanExecution');
  expect(await f.service.controlTaskHumanExecution(f.context(), command, 0)).toMatchObject({
    ack: { revision: 1 },
    input: f.input,
  });
  expect(f.ports.control).toHaveBeenCalledExactlyOnceWith(f.context(), command, 0);
});
it.each(['abort', 'mutation'] as const)(
  'rejects %s during awaited control validation before calling the control owner',
  async (defect) => {
    const f = fixture(),
      abort = new AbortController();
    native.signal = abort.signal;
    vi.mocked(f.ports.technical).mockImplementationOnce(async (technical) => {
      if (defect === 'abort') abort.abort();
      else technical.records.push(f.ref);
    });
    const command = {
      schemaVersion: 2 as const,
      commandId: 'pause',
      hash: f.ref.sha256,
      action: 'pause' as const,
      target: taskControlTarget(f.input),
      expectedRevision: 0,
      attempt: 0,
      author: 'owner',
      source: f.ref,
      payload: f.ref,
    };
    f.at('controlTaskHumanExecution');
    const count = f.artifactCount();
    await expect(f.service.controlTaskHumanExecution(f.context(), command, 0)).rejects.toThrow(
      defect === 'mutation' ? 'human-verification-stale' : undefined,
    );
    expect(f.ports.control).not.toHaveBeenCalled();
    expect(f.effects()).toBe(0);
    expect(f.artifactCount()).toBe(count);
  },
);
it.each([false, true])(
  'replays a retained requirements chain with prior commands=%s and invalidates old consent',
  async (priorCommands) => {
    const f = fixture();
    if (priorCommands) {
      await f.apply('ASK');
      await f.apply('DECIDE');
    }
    const next: HumanManagedTaskInput = {
      ...f.input,
      admission: {
        ...f.input.admission,
        preparation: { ...f.input.admission.preparation, revision: 2 },
      },
    };
    const verified = f.declare(next, f.initial);
    next.startAdmission = verified.ref;
    const state = advanceTaskHumanRequirements(f.context().state, {
      kind: 'verified-task-human-requirements',
      commandId: 'requirements2',
      hash: verified.manifest.ref.sha256,
      previousManifest: f.initial.manifest.ref,
      next: verified.manifest,
      expectedRevision: f.context().state.revision,
      source: verified.ref,
      proof: verified.manifest.ref,
    });
    const technical = {
      ...f.technical,
      input: next,
      packet: { ...f.technical.packet, preparation: next.admission.preparation },
      stopped: f.save({ confirmed: true, input: next }),
    };
    f.setContext({ input: next, state, technical });
    f.at('finishTaskHuman');
    await expect(
      f.service.finishTaskHuman({
        schemaVersion: 1,
        kind: 'task-human-finish',
        ...f.context(),
        state: { ...state, closed: true },
        expectedRevision: state.revision,
      }),
    ).rejects.toThrow('human-gates-open');
    await f.apply('ASK');
    await f.apply('DECIDE');
    f.at('finishTaskHuman');
    expect(await f.service.finishTaskHuman(f.request())).toMatchObject({ status: 'done' });
    expect(f.effects()).toBe(1);
    const row = f.context().state.history.find((entry) => entry.kind === 'requirements')!;
    const changed = { ...row, source: f.ref };
    f.at('verifyTaskHumanCommand');
    await expect(
      f.service.verifyTaskHumanCommand(
        {
          ...f.context(),
          state: {
            ...f.context().state,
            history: f.context().state.history.map((entry) => (entry === row ? changed : entry)),
          },
        },
        f.command('ASK'),
      ),
    ).rejects.toThrow('human-requirements-proof');
  },
);
it('pins paused human checkpoints to the actual producer and permits only confirmed server continuation', async () => {
  const f = fixture(),
    value = f.checkpoint();
  f.at('saveTaskHumanCheckpoint');
  const ref = await f.service.saveTaskHumanCheckpoint(value);
  expect(JSON.parse(f.store.read(ref).toString())).toMatchObject({
    kind: 'task-human-checkpoint',
    wait: { kind: 'human-gates', paused: true },
  });
  f.at('loadTaskHumanCheckpoint');
  native.info.workflowExecution = { workflowId: localTaskKey(f.input), runId: 'run-two' };
  expect(await f.service.loadTaskHumanCheckpoint(f.input, ref, 'run-one')).toEqual(value);
  for (const predecessor of ['', 'run-two', 'other-run'])
    await expect(f.service.loadTaskHumanCheckpoint(f.input, ref, predecessor)).rejects.toThrow(
      'human-checkpoint-producer',
    );
  const raw = f.save({
    ...value,
    kind: 'task-human-checkpoint',
    diagnostics: [{ phase: 'unconfirmed', error: 'raw caller bytes' }],
  });
  await expect(f.service.loadTaskHumanCheckpoint(f.input, raw, 'run-one')).rejects.toThrow();
  expect(f.effects()).toBe(0);
});
it('rejects checkpoint producer, stop, budget and prefix inconsistencies while retaining saved evidence', async () => {
  const f = fixture(),
    value = f.checkpoint();
  f.at('saveTaskHumanCheckpoint');
  await expect(
    f.service.saveTaskHumanCheckpoint({
      ...value,
      producer: { ...value.producer, runId: 'foreign' },
    }),
  ).rejects.toThrow('human-checkpoint-producer');
  await expect(f.service.saveTaskHumanCheckpoint({ ...value, revision: -1 })).rejects.toThrow(
    'human-checkpoint-invalid',
  );
  await expect(f.service.saveTaskHumanCheckpoint({ ...value, technical: null })).rejects.toThrow(
    'human-checkpoint-technical-required',
  );
  f.setBudget({ limit: 20, used: 3, manifest: f.ref });
  await expect(f.service.saveTaskHumanCheckpoint(value)).rejects.toThrow('human-checkpoint-budget');
  f.setBudget({ limit: 21, used: 4, manifest: f.ref });
  await expect(f.service.saveTaskHumanCheckpoint(value)).rejects.toThrow('human-checkpoint-budget');
  f.setBudget({ limit: 20, used: 5, manifest: f.ref });
  const previous = await f.service.saveTaskHumanCheckpoint(value);
  expect(await f.service.saveTaskHumanCheckpoint(value)).toEqual(previous);
  expect(await f.service.saveTaskHumanCheckpoint({ ...value, previous })).toBeDefined();
  await expect(
    f.service.saveTaskHumanCheckpoint({ ...value, previous, beganAt: 43 }),
  ).rejects.toThrow('human-checkpoint-prefix');
  const stop = f.save({ confirmed: true, input: f.input }),
    held = f.save({ input: f.input, stopped: stop });
  expect(
    await f.service.saveTaskHumanCheckpoint({
      ...value,
      technical: null,
      wait: { kind: 'execution-held', stop, held },
    }),
  ).toBeDefined();
  const falseStop = f.save({ confirmed: false, input: f.input }),
    falseHeld = f.save({ input: f.input, stopped: falseStop });
  await expect(
    f.service.saveTaskHumanCheckpoint({
      ...value,
      technical: null,
      wait: { kind: 'execution-held', stop: falseStop, held: falseHeld },
    }),
  ).rejects.toThrow('human-checkpoint-stop');
});
it('retains checkpoint publication failures and rejects conflicting private receipts', async () => {
  const f = fixture(false),
    value = f.checkpoint();
  f.at('saveTaskHumanCheckpoint');
  const original = artifactFiles.publishFile;
  const spy = vi.spyOn(artifactFiles, 'publishFile').mockImplementation((path, bytes) => {
    if (path.includes('human-checkpoints'))
      throw Object.assign(new Error('checkpoint I/O unavailable'), { code: 'EIO' });
    original(path, bytes);
  });
  await expect(f.service.saveTaskHumanCheckpoint(value)).rejects.toThrow(
    'checkpoint I/O unavailable',
  );
  spy.mockRestore();
  const saved = await f.service.saveTaskHumanCheckpoint(value);
  writeFileSync(f.location('checkpoints', saved.sha256), JSON.stringify(f.ref));
  await expect(f.service.saveTaskHumanCheckpoint(value)).rejects.toThrow('human-receipt-conflict');
  expect(f.effects()).toBe(0);
});
it('binds artifact root identity and rejects a foreign store before publication', async () => {
  const f = fixture(false);
  f.at('finishTaskHuman');
  const foreign = privateDirectory(join(f.root, 'foreign'));
  const service = taskHumanActivities({ ...f.registration, artifactRoot: foreign }, f.ports);
  await expect(service.finishTaskHuman(f.request())).rejects.toThrow();
  renameSync(f.registration.artifactRoot, f.registration.artifactRoot + '-retained');
  mkdirSync(f.registration.artifactRoot);
  await expect(f.service.finishTaskHuman(f.request())).rejects.toThrow('artifact-root-changed');
  expect(f.effects()).toBe(0);
});
