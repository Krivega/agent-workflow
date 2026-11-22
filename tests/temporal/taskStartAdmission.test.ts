import type { Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type {
  PreparationInput,
  ArtifactRef,
  LocalProjectRegistration,
} from '../../src/contracts/preparation.js';
import type {
  TaskStartAdmission,
  TaskStartDeclaration,
} from '../../src/contracts/taskStartAdmission.js';
import {
  parseTaskStartAdmission,
  parseTaskStartPrincipal,
} from '../../src/policy/taskStartAdmission.js';
import { taskHumanCanonical } from '../../src/policy/taskHuman.js';
import { parseLocalTask } from '../../src/policy/localTask.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import * as artifactFiles from '../../src/adapters/artifacts/files.js';
import { artifactStore, nativeTaskSource } from '../../src/client/taskExecution.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import {
  bindTaskBackendClient,
  checkTaskStartAdmission,
  prepareTaskStartAdmission,
  reserveNewTaskBackend,
} from '../../src/client/taskBackend.js';
import type { TaskBackendRegistration } from '../../src/client/taskBackend.js';
import { startLocalTask, startPreparedLocalTask } from '../../src/client/localTask.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

const transport = vi.hoisted(() => ({
  lazy: vi.fn(),
  client: vi.fn(),
  start: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock('@temporalio/client', () => ({
  Connection: { lazy: transport.lazy },
  Client: class {
    readonly connection: unknown;
    constructor(readonly options: { connection: unknown; namespace: string }) {
      this.connection = options.connection;
      transport.client(options);
    }
    readonly workflow = { start: transport.start };
  },
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const technical = 'K1: Проверить вычисление';
const human = 'Ребёнок понимает результат без подсказки';
const card = `# Задача\r\n\r\n## Критерии приёмки\r\n\r\n- [ ] ${technical}\r\n- [x] ${human}\r\n`;
function fixture(content = card) {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'aw-start-admission-')));
  roots.push(root);
  const workspace = join(root, 'workspace'),
    artifactRoot = join(root, 'artifacts');
  mkdirSync(join(workspace, 'tasks'), { recursive: true });
  mkdirSync(artifactRoot);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  const input: PreparationInput = {
    schemaVersion: 1,
    taskId: 'task',
    project: {
      schemaVersion: 1,
      projectId: 'project',
      workspaceId: 'workspace',
      rules: ['rule.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
      checks: ['validate'],
    },
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    revision: 1,
    card: 'tasks/one.md',
  };
  const registration: LocalProjectRegistration = {
    project: input.project,
    hostId: input.hostId,
    owner: input.owner,
    generation: input.generation,
    workspaceRoot: workspace,
    artifactRoot,
    commands: {},
  };
  const cardPath = join(workspace, input.card);
  writeFileSync(cardPath, content);
  const store = artifactStore(artifactRoot, { existingOnly: true });
  const principal = {
    owner: 'owner',
    threadId: 'thread',
    turnId: 'turn',
    source: { locator: '/synthetic/native.jsonl#L2', hash: 'b'.repeat(64) },
    proof: store.publish(Buffer.from('synthetic native principal proof')),
  };
  const authority = {
    issue: vi.fn(async () => structuredClone(principal)),
    verify: vi.fn(async (value: unknown) => {
      expect(value).toEqual(principal);
    }),
  };
  const declaration: TaskStartDeclaration = {
    preparation: input,
    previous: null,
    human: content === card ? [human] : [],
    inapplicable: [],
  };
  const prepare = () => prepareTaskStartAdmission(registration, authority, declaration);
  const home = taskBackendHome(workspace);
  function policy(version = 2, newTasks = 'temporal') {
    declareBackendFixture(workspace);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({
        schemaVersion: version,
        newTasks,
        ...(version === 2 ? { startAdmission: 'task-start-admission/1' } : {}),
      }),
    );
  }
  function reserve(ref: ArtifactRef) {
    return reserveTaskBackend(
      workspace,
      {
        schemaVersion: 2,
        projectId: input.project.projectId,
        taskId: input.taskId,
        backend: 'temporal',
        cardName: 'one.md',
        origin: digest(readFileSync(cardPath)),
        startAdmission: ref,
      },
      { registration, authority, preparation: input },
    );
  }
  function forged(value: TaskStartAdmission) {
    const parsed = parseTaskStartAdmission(value),
      ref = store.publish(Buffer.from(JSON.stringify(parsed)));
    store.publish(
      Buffer.from(
        taskHumanCanonical({
          schemaVersion: 1,
          kind: 'task-human-gate-manifest',
          target: parsed.target,
          card: parsed.card,
          requirements: parsed.requirements,
          declaration: ref,
          criteria: parsed.criteria,
        }),
      ),
    );
    return ref;
  }
  function task(ref: ArtifactRef): HumanManagedTaskInput {
    const accepted = store.publish(Buffer.from('accepted existing technical inputs'));
    return {
      schemaVersion: 12,
      startAdmission: ref,
      admission: {
        schemaVersion: 3,
        preparation: input,
        plan: { path: 'plan.json', sha256: 'c'.repeat(64) },
        planning: accepted,
        acceptance: accepted,
      },
      executor: { path: 'executor.md', sha256: 'd'.repeat(64) },
      baseline: 'baseline',
      continuation: { attempt: 0, previous: null },
    };
  }
  return {
    root,
    workspace,
    artifactRoot,
    input,
    registration,
    cardPath,
    store,
    principal,
    authority,
    declaration,
    prepare,
    home,
    policy,
    reserve,
    forged,
    task,
  };
}

it('retains the complete origin inventory, raw CRLF bytes, principal and declaration before planning', async () => {
  const f = fixture(),
    prepared = await f.prepare();
  expect(prepared.admission.card).toEqual({
    path: f.input.card,
    sha256: digest(card),
    bytes: Buffer.byteLength(card),
  });
  expect(prepared.admission.requirements).toEqual({
    sha256: digest(card),
    bytes: Buffer.byteLength(card),
  });
  expect(prepared.admission.criteria.map((row) => [row.id, row.kind, row.applicable])).toEqual([
    ['K1', 'check', true],
    [human, 'human', true],
  ]);
  expect(prepared.manifest.manifest.declaration).toEqual(prepared.ref);
  expect(prepared.admission).not.toHaveProperty('manifest');
  expect(f.store.read(prepared.manifest.ref).toString()).toBe(
    taskHumanCanonical(prepared.manifest.manifest),
  );
  expect(f.authority.issue).toHaveBeenCalledTimes(2);
  expect(f.authority.verify).toHaveBeenCalledWith(f.principal);
});
it('requires an explicit retained empty declaration even when the origin has no criteria', async () => {
  const f = fixture('# Task without declared human criteria\n');
  const result = await f.prepare();
  expect(result.admission.criteria).toEqual([]);
  expect(result.ref.bytes).toBeGreaterThan(0);
  expect(result.manifest.manifest.criteria).toEqual([]);
});
it('preserves opaque long human IDs and owner applicability reasons', async () => {
  const criterion = '  Полный критерий ' + 'я'.repeat(30000);
  const f = fixture(`## Критерии\n- [ ] ${criterion}\n`);
  const normalized = criterion.trim();
  f.declaration.human = [normalized];
  f.declaration.inapplicable = [{ criterion: normalized, reason: 'Не входит в текущую редакцию' }];
  const result = await f.prepare();
  expect(result.admission.criteria).toEqual([
    {
      id: normalized,
      text: normalized,
      kind: 'human',
      applicable: false,
      reason: 'Не входит в текущую редакцию',
    },
  ]);
});
it.each(['partial', 'extra', 'order', 'id', 'text', 'reason'])(
  'rejects a later incomplete or changed inventory even with fresh content hashes: %s',
  async (kind) => {
    const f = fixture(),
      prepared = await f.prepare(),
      value = structuredClone(prepared.admission);
    if (kind === 'partial') value.criteria.pop();
    if (kind === 'extra')
      value.criteria.push({ ...value.criteria[0]!, id: 'extra', text: 'Undeclared' });
    if (kind === 'order') value.criteria.reverse();
    if (kind === 'id') value.criteria[0]!.id = 'changed';
    if (kind === 'text') value.criteria[0]!.text += ' changed';
    if (kind === 'reason') value.criteria[0]!.reason = 'Changed interpretation after retention';
    await expect(
      checkTaskStartAdmission(f.registration, f.authority, f.forged(value), f.input),
    ).rejects.toThrow('task-start-incomplete-criteria');
  },
);
it.each([
  'unknown-human',
  'duplicate-human',
  'unknown-applicability',
  'duplicate-applicability',
  'empty-reason',
  'duplicate-id',
  'encoding',
])('refuses invalid initial declarations before issuance or publication: %s', async (kind) => {
  const f = fixture(),
    before = readdirSync(f.artifactRoot);
  if (kind === 'unknown-human') f.declaration.human = ['foreign'];
  if (kind === 'duplicate-human') f.declaration.human.push(human);
  if (kind === 'unknown-applicability')
    f.declaration.inapplicable = [{ criterion: 'foreign', reason: 'outside' }];
  if (kind === 'duplicate-applicability')
    f.declaration.inapplicable = [
      { criterion: human, reason: 'outside' },
      { criterion: human, reason: 'outside' },
    ];
  if (kind === 'empty-reason') f.declaration.inapplicable = [{ criterion: human, reason: '' }];
  if (kind === 'duplicate-id') {
    writeFileSync(f.cardPath, '## Критерии\n- [ ] C: first\n- [ ] C: second\n');
    f.declaration.human = [];
  }
  if (kind === 'encoding') writeFileSync(f.cardPath, Buffer.from([0xff]));
  await expect(f.prepare()).rejects.toThrow();
  expect(f.authority.issue).not.toHaveBeenCalled();
  expect(readdirSync(f.artifactRoot)).toEqual(before);
});
it.each(['owner', 'principal-race', 'card-race'])(
  'rechecks real issuance scope before artifact writes: %s',
  async (kind) => {
    const f = fixture(),
      before = readdirSync(f.artifactRoot);
    if (kind === 'owner') f.authority.issue.mockResolvedValue({ ...f.principal, owner: 'foreign' });
    if (kind === 'principal-race')
      f.authority.issue
        .mockResolvedValueOnce(f.principal)
        .mockResolvedValue({ ...f.principal, turnId: 'next-turn' });
    if (kind === 'card-race')
      f.authority.issue
        .mockImplementationOnce(async () => f.principal)
        .mockImplementation(async () => {
          writeFileSync(f.cardPath, card + '\nchanged');
          return f.principal;
        });
    await expect(f.prepare()).rejects.toThrow();
    expect(readdirSync(f.artifactRoot)).toEqual(before);
  },
);
it('retained reads preserve immutable source checks while allowing STOP after a card projection', async () => {
  const f = fixture(),
    prepared = await f.prepare();
  writeFileSync(f.cardPath, '# Completed projection\n');
  await expect(
    checkTaskStartAdmission(f.registration, f.authority, prepared.ref, f.input),
  ).rejects.toThrow('task-start-card-changed');
  expect(
    await checkTaskStartAdmission(f.registration, f.authority, prepared.ref, f.input, undefined, {
      card: 'retained',
    }),
  ).toEqual(prepared);
  f.authority.verify.mockRejectedValue(new Error('native-source-unconfirmed'));
  await expect(
    checkTaskStartAdmission(f.registration, f.authority, prepared.ref, f.input, undefined, {
      card: 'retained',
    }),
  ).rejects.toThrow('native-source-unconfirmed');
});
it('binds an initial declaration once and keeps the immutable origin through a full next revision', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.policy();
  const client = {} as Client;
  bindTaskBackendClient(client, f.registration, f.authority);
  const assignment = await reserveNewTaskBackend(client, f.input, initial.ref);
  expect(assignment).toMatchObject({
    schemaVersion: 2,
    origin: initial.admission.card.sha256,
    startAdmission: initial.ref,
  });
  expect(await reserveNewTaskBackend(client, f.input, initial.ref)).toEqual(assignment);
  writeFileSync(f.cardPath, `## Критерии\n- [ ] Новый полный критерий\n`);
  f.input.revision = 2;
  f.declaration.previous = initial.ref;
  f.declaration.human = ['Новый полный критерий'];
  const next = await f.prepare();
  expect(next.initial).toEqual({ ref: initial.ref, admission: initial.admission });
  expect(next.admission.criteria).toHaveLength(1);
  expect(
    await checkTaskStartAdmission(f.registration, f.authority, next.ref, f.input, assignment),
  ).toEqual(next);
  const saved = readFileSync(join(f.home, 'backend-assignments/project/task.json'));
  expect((JSON.parse(saved.toString()) as { origin: unknown }).origin).toBe(
    initial.admission.card.sha256,
  );
  await expect(reserveNewTaskBackend(client, f.input, next.ref)).rejects.toThrow();
  expect(readFileSync(join(f.home, 'backend-assignments/project/task.json'))).toEqual(saved);
});
it.each(['same-revision', 'skip-revision', 'foreign-task'])(
  'refuses invalid previous declaration transitions before issuance or publication: %s',
  async (kind) => {
    const f = fixture(),
      initial = await f.prepare(),
      before = readdirSync(f.artifactRoot);
    f.declaration.previous = initial.ref;
    f.input.revision = kind === 'skip-revision' ? 3 : kind === 'same-revision' ? 1 : 2;
    if (kind === 'foreign-task') f.input.taskId = 'foreign-task';
    f.authority.issue.mockClear();
    await expect(f.prepare()).rejects.toThrow('task-start-revision-chain');
    expect(f.authority.issue).not.toHaveBeenCalled();
    expect(readdirSync(f.artifactRoot)).toEqual(before);
  },
);
it('refuses card changes during prior verification before issuing a new proof', async () => {
  const f = fixture(),
    initial = await f.prepare(),
    before = readdirSync(f.artifactRoot);
  f.input.revision = 2;
  f.declaration.previous = initial.ref;
  f.authority.issue.mockClear();
  f.authority.verify.mockImplementationOnce(async () => {
    writeFileSync(f.cardPath, card + '\nchanged');
  });
  await expect(f.prepare()).rejects.toThrow('task-start-card-changed');
  expect(f.authority.issue).not.toHaveBeenCalled();
  expect(readdirSync(f.artifactRoot)).toEqual(before);
});
it.each(['origin', 'ref', 'card', 'task', 'project'])(
  'checks immutable assignment identity against the initial admission: %s',
  async (kind) => {
    const f = fixture(),
      prepared = await f.prepare();
    const assignment = {
      projectId: 'project',
      taskId: 'task',
      cardName: 'one.md',
      origin: prepared.admission.card.sha256,
      startAdmission: prepared.ref,
    };
    if (kind === 'origin') assignment.origin = 'f'.repeat(64);
    if (kind === 'ref') assignment.startAdmission = f.principal.proof;
    if (kind === 'card') assignment.cardName = 'other.md';
    if (kind === 'task') assignment.taskId = 'other-task';
    if (kind === 'project') assignment.projectId = 'other-project';
    await expect(
      checkTaskStartAdmission(f.registration, f.authority, prepared.ref, f.input, assignment),
    ).rejects.toThrow('task-start-assignment');
  },
);
it('rejects policy2 downgrade before allocating assignment directories and preserves an existing v1 row', () => {
  const f = fixture();
  const row = {
    schemaVersion: 1 as const,
    projectId: 'project',
    taskId: 'task',
    backend: 'temporal' as const,
    cardName: 'one.md',
    origin: digest(card),
  };
  const reserved = reserveTaskBackend(f.workspace, row);
  const bytes = readFileSync(join(f.home, 'backend-assignments/project/task.json'));
  f.policy();
  expect(reserveTaskBackend(f.workspace, row)).toEqual(reserved);
  expect(readFileSync(join(f.home, 'backend-assignments/project/task.json'))).toEqual(bytes);
  expect(() =>
    reserveTaskBackend(f.workspace, { ...row, projectId: 'new-project', taskId: 'new-task' }),
  ).toThrow('task-start-admission-required');
  expect(existsSync(join(f.home, 'backend-assignments/new-project'))).toBe(false);
});
it('checks real store/source before low-level schema2 reservation', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.policy();
  const row = {
    schemaVersion: 2 as const,
    projectId: 'project',
    taskId: 'task',
    backend: 'temporal' as const,
    cardName: 'one.md',
    origin: digest(card),
    startAdmission: initial.ref,
  };
  f.authority.verify.mockRejectedValue(new Error('actual-principal-source-refused'));
  await expect(
    reserveTaskBackend(f.workspace, row, {
      registration: f.registration,
      authority: f.authority,
      preparation: f.input,
    }),
  ).rejects.toThrow('actual-principal-source-refused');
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
});
it.each([
  ['absent', 'task-start-policy-required'],
  ['version1', 'task-start-policy-required'],
  ['blocked', 'backend-new-tasks-blocked'],
])('rejects a new direct schema2 assignment under %s policy', async (policy, reason) => {
  const f = fixture(),
    initial = await f.prepare();
  if (policy === 'version1') f.policy(1);
  if (policy === 'blocked') f.policy(2, 'blocked');
  f.authority.verify.mockClear();
  await expect(Promise.resolve().then(() => f.reserve(initial.ref))).rejects.toThrow(reason);
  expect(f.authority.verify).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
});
it('rechecks the new-task policy after awaiting the verified principal', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.policy();
  f.authority.verify.mockImplementationOnce(async () => f.policy(2, 'blocked'));
  await expect(f.reserve(initial.ref)).rejects.toThrow('backend-new-tasks-blocked');
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
});
it('rechecks the policy when a new start is blocked during the locked assignment scan', async () => {
  const f = fixture(),
    initial = await f.prepare();
  const prior = {
    schemaVersion: 1 as const,
    projectId: f.input.project.projectId,
    taskId: 'prior',
    backend: 'legacy' as const,
    cardName: 'prior.md',
    origin: 'a'.repeat(64),
  };
  reserveTaskBackend(f.workspace, prior);
  f.policy();
  const directory = join(f.home, 'backend-assignments/project'),
    existing = join(directory, 'prior.json'),
    lock = join(directory, 'assignment-lock'),
    read = artifactFiles.readPrivateFile;
  let blocked = false;
  vi.spyOn(artifactFiles, 'readPrivateFile').mockImplementation((path) => {
    if (path === existing && existsSync(lock)) {
      f.policy(2, 'blocked');
      blocked = true;
    }
    return read(path);
  });
  await expect(f.reserve(initial.ref)).rejects.toThrow('backend-new-tasks-blocked');
  expect(blocked).toBe(true);
  expect(readdirSync(directory)).toEqual(['prior.json']);
  expect(readFileSync(existing, 'utf8')).toBe(JSON.stringify(prior));
});
it('preserves a previously assigned schema2 route during a new-start block', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.policy();
  const assigned = await f.reserve(initial.ref);
  const path = join(f.home, 'backend-assignments/project/task.json'),
    bytes = readFileSync(path);
  f.policy(2, 'blocked');
  expect(await f.reserve(initial.ref)).toEqual(assigned);
  expect(readFileSync(path)).toEqual(bytes);
});
it('starts v12 only through the bound port and refuses missing/degraded input before SDK RPC', async () => {
  const f = fixture(),
    initial = await f.prepare(),
    input = f.task(initial.ref);
  f.policy();
  const handle = { query: vi.fn(async () => input) },
    start = vi.fn(async (_name: string, _options: unknown) => handle),
    client = { workflow: { start } } as unknown as Client;
  bindTaskBackendClient(client, f.registration, f.authority);
  await reserveNewTaskBackend(client, f.input, initial.ref);
  const { startAdmission: _ref, ...missing } = input;
  await expect(startLocalTask(client, missing, 'queue')).rejects.toThrow();
  await expect(startLocalTask(client, { ...missing, schemaVersion: 11 }, 'queue')).rejects.toThrow(
    'task-start-admission-required',
  );
  expect(start).not.toHaveBeenCalled();
  expect(await startLocalTask(client, input, 'queue')).toBe(handle);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[1]).toMatchObject({ args: [parseLocalTask(input)] });
});
it('detects workspace replacement during a historical principal check, even for retained reads', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.authority.verify.mockImplementation(async () => {
    renameSync(f.workspace, f.workspace + '-prior');
    mkdirSync(f.workspace);
  });
  await expect(
    checkTaskStartAdmission(f.registration, f.authority, initial.ref, f.input, undefined, {
      card: 'retained',
    }),
  ).rejects.toThrow('task-start-workspace-changed');
});
it.each(['version', 'extra', 'duplicate', 'principal-source'])(
  'parses exact admission and principal structures: %s',
  async (kind) => {
    const f = fixture(),
      initial = await f.prepare(),
      value = structuredClone(initial.admission);
    if (kind === 'version') Object.assign(value, { schemaVersion: 2 });
    if (kind === 'extra') Object.assign(value, { complete: true });
    if (kind === 'duplicate') value.criteria.push(value.criteria[0]!);
    if (kind === 'principal-source') value.principal.source.hash = 'invalid';
    expect(() => parseTaskStartAdmission(value)).toThrow();
  },
);
it('refuses a self-attested or absent principal binding', () => {
  expect(() => parseTaskStartPrincipal({ verified: true })).toThrow();
});
it('requires the configured issuance port before new policy2 reservation', async () => {
  const f = fixture(),
    initial = await f.prepare();
  f.policy();
  const client = {} as Client;
  bindTaskBackendClient(client, f.registration);
  expect(() => reserveNewTaskBackend(client, f.input)).toThrow('task-start-admission-required');
  expect(() => reserveNewTaskBackend(client, f.input, initial.ref)).toThrow(
    'task-start-admission-required',
  );
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
  const registrationWithoutArtifactRoot: TaskBackendRegistration = { ...f.registration };
  delete registrationWithoutArtifactRoot.artifactRoot;
  expect(() =>
    bindTaskBackendClient({} as Client, registrationWithoutArtifactRoot, f.authority),
  ).toThrow('task-start-artifact-root-required');
});
it('keeps the old policy1 start and missing future artifact-root behavior unchanged', async () => {
  const f = fixture(),
    initial = await f.prepare(),
    { startAdmission: _ref, ...fields } = f.task(initial.ref),
    input = { ...fields, schemaVersion: 11 as const };
  f.policy(1);
  const handle = { query: vi.fn(async () => input) },
    start = vi.fn(async () => handle),
    client = { workflow: { start } } as unknown as Client;
  bindTaskBackendClient(client, {
    ...f.registration,
    artifactRoot: join(f.root, 'not-yet-created'),
  });
  expect(reserveNewTaskBackend(client, f.input).schemaVersion).toBe(1);
  expect(() => reserveNewTaskBackend(client, f.input, initial.ref)).toThrow(
    'task-start-policy-required',
  );
  expect(await startLocalTask(client, input, 'queue')).toBe(handle);
  expect(existsSync(join(f.root, 'not-yet-created'))).toBe(false);
});
it('refuses external v12 continuation starts and substituted admission hashes before RPC', async () => {
  const f = fixture(),
    initial = await f.prepare(),
    input = f.task(initial.ref);
  f.policy();
  const start = vi.fn(),
    client = { workflow: { start } } as unknown as Client;
  bindTaskBackendClient(client, f.registration, f.authority);
  await reserveNewTaskBackend(client, f.input, initial.ref);
  await expect(
    startLocalTask(
      client,
      { ...input, continuation: { attempt: 1, previous: initial.ref } },
      'queue',
    ),
  ).rejects.toThrow('task-continuation-start-forbidden');
  await expect(
    startLocalTask(client, { ...input, startAdmission: f.principal.proof }, 'queue'),
  ).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});
it('does not publish a declaration after its trusted registration changes during issuance', async () => {
  const f = fixture(),
    before = readdirSync(f.artifactRoot);
  f.authority.issue
    .mockImplementationOnce(async () => f.principal)
    .mockImplementation(async () => {
      f.registration.generation++;
      return f.principal;
    });
  await expect(f.prepare()).rejects.toThrow('preparation-grant-mismatch');
  expect(readdirSync(f.artifactRoot)).toEqual(before);
});

async function preparedStartFixture() {
  const f = substantialTaskFixture(),
    declaration = f.substantialInput.admission,
    preparation = declaration.preparation,
    registration = {
      ...f.registration,
      taskBackend: 'required' as const,
      commands: {
        ...f.registration.commands,
        smoke: { ...f.registration.commands.smoke, timeoutMs: 30_000 },
      },
    };
  writeFileSync(join(f.workspace, preparation.card), card);
  f.proposal.requirement.hash = digest(card);
  const plan = Buffer.from(JSON.stringify(f.proposal));
  writeFileSync(join(f.workspace, declaration.plan.path), plan);

  const threadId = 'prepared-start-thread',
    turnId = 'prepared-start-turn',
    sessionsRoot = join(f.root, 'sessions'),
    transcript = join(sessionsRoot, 'rollout-' + threadId + '.jsonl'),
    message = 'Start this prepared task.';
  mkdirSync(sessionsRoot, { mode: 0o700 });
  vi.spyOn(process, 'cwd').mockReturnValue(f.workspace);
  vi.stubEnv('CODEX_HOME', f.root);
  vi.stubEnv('CODEX_THREAD_ID', threadId);
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
  const user = row('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: message }],
    internal_chat_message_metadata_passthrough: {
      turn_id: turnId,
      create_time: 1,
      content_item_kinds: ['user.text'],
      content_item_metadata: [{ provenance: { type: 'user' } }],
    },
  });
  writeFileSync(
    transcript,
    [
      row('session_meta', {
        id: threadId,
        session_id: threadId,
        cli_version: '0.166.0-alpha.6',
        cwd: f.workspace,
        source: 'vscode',
        originator: 'codex_work_desktop',
        thread_source: 'user',
      }),
      row('event_msg', { type: 'task_started', turn_id: turnId }),
      row('turn_context', { turn_id: turnId, cwd: f.workspace }),
      user,
      row('event_msg', {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turnId,
        item: {
          type: 'UserMessage',
          content: [{ type: 'text', text: message, text_elements: [] }],
        },
      }),
    ].join(''),
    { mode: 0o600 },
  );
  const source = nativeTaskSource(f.store, {
    sessionsRoot,
    chatWorkspace: f.workspace,
    threadId,
    owner: registration.owner,
  });
  const start = await prepareTaskStartAdmission(
    registration,
    {
      issue: () => source.issue({ transcript, turnId, user: { line: 4, sha256: digest(user) } }),
      verify: source.verify,
    },
    { preparation, previous: null, human: [human], inapplicable: [] },
  );
  const home = taskBackendHome(f.workspace);
  declareBackendFixture(f.workspace);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'backend-policy.json'),
    JSON.stringify({
      schemaVersion: 2,
      newTasks: 'temporal',
      startAdmission: 'task-start-admission/1',
    }),
  );
  const input: HumanManagedTaskInput = {
    ...f.substantialInput,
    admission: { ...declaration, plan: { ...declaration.plan, sha256: digest(plan) } },
    schemaVersion: 12,
    startAdmission: start.ref,
    continuation: { attempt: 0, previous: null },
  };
  const config = {
    schemaVersion: 1,
    address: '127.0.0.1:7233',
    namespace: 'prepared-start',
    taskQueue: 'prepared-tasks',
    registration,
  };
  transport.lazy.mockReset().mockImplementation((options: unknown) => ({
    options,
    close: transport.close,
  }));
  transport.client.mockClear();
  transport.start.mockReset();
  transport.close.mockClear();
  return { ...f, input, config, home, transcript, verify: source.verify };
}

it('starts a prepared task through the SDK under one immutable assignment and Workflow identity', async () => {
  const f = await preparedStartFixture(),
    assignment = join(f.home, 'backend-assignments/neutral/one.json'),
    artifacts = readdirSync(f.config.registration.artifactRoot),
    query = vi.fn(async () => f.input);
  const admitted = await checkTaskStartAdmission(
    f.config.registration,
    { verify: f.verify },
    f.input.startAdmission,
    f.input.admission.preparation,
  );
  expect(admitted.initial.ref).toEqual(f.input.startAdmission);
  expect(readdirSync(f.config.registration.artifactRoot)).toEqual(artifacts);
  expect(existsSync(assignment)).toBe(false);
  expect(transport.start).not.toHaveBeenCalled();
  transport.start.mockImplementation(async () => {
    expect(JSON.parse(readFileSync(assignment, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      projectId: 'neutral',
      taskId: 'one',
      backend: 'temporal',
      origin: digest(card),
      startAdmission: f.input.startAdmission,
      route: {
        address: f.config.address,
        namespace: f.config.namespace,
        taskQueue: f.config.taskQueue,
      },
    });
    return { workflowId: 'aw/task/neutral/one', firstExecutionRunId: 'existing-run', query };
  });
  await expect(startPreparedLocalTask(f.workspace, f.input, f.config)).resolves.toEqual({
    status: 'accepted',
    backend: 'temporal',
    workflowId: 'aw/task/neutral/one',
  });
  const first = readFileSync(assignment);
  await startPreparedLocalTask(f.workspace, f.input, f.config);
  expect(readFileSync(assignment)).toEqual(first);
  expect(readdirSync(f.config.registration.artifactRoot)).toEqual(artifacts);
  expect(transport.lazy).toHaveBeenCalledWith({ address: f.config.address });
  expect(transport.client).toHaveBeenCalledWith({
    connection: { options: { address: f.config.address }, close: transport.close },
    namespace: f.config.namespace,
  });
  expect(transport.start.mock.calls).toEqual(
    Array.from({ length: 2 }, () => [
      'LocalTaskWorkflow',
      {
        args: [f.input],
        taskQueue: f.config.taskQueue,
        workflowId: 'aw/task/neutral/one',
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      },
    ]),
  );
  expect(query.mock.calls).toEqual([['localTaskInput'], ['localTaskInput']]);
  expect(transport.close).toHaveBeenCalledTimes(2);
});

it('refuses to redirect an existing start to another address, namespace, or queue', async () => {
  const f = await preparedStartFixture(),
    assignment = join(f.home, 'backend-assignments/neutral/one.json'),
    query = vi.fn(async () => f.input);
  transport.start.mockResolvedValue({ workflowId: 'aw/task/neutral/one', query });
  await startPreparedLocalTask(f.workspace, f.input, f.config);
  const before = readFileSync(assignment),
    artifacts = readdirSync(f.config.registration.artifactRoot);
  for (const replacement of [
    { address: '127.0.0.1:17233' },
    { namespace: 'foreign-namespace' },
    { taskQueue: 'foreign-tasks' },
  ]) {
    await expect(
      startPreparedLocalTask(f.workspace, f.input, { ...f.config, ...replacement }),
    ).rejects.toThrow('backend-assignment-conflict');
    const route = { ...f.config, ...replacement };
    const client = {
      workflow: { start: transport.start },
      connection: { options: { address: route.address } },
      options: { namespace: route.namespace },
    } as unknown as Client;
    bindTaskBackendClient(client, f.config.registration, { verify: f.verify });
    await expect(startLocalTask(client, f.input, route.taskQueue)).rejects.toThrow(
      'task-start-route-conflict',
    );
    expect(readFileSync(assignment)).toEqual(before);
    expect(readdirSync(f.config.registration.artifactRoot)).toEqual(artifacts);
  }
  expect(transport.start).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(1);
});

it.each([1, 2])(
  'refuses a plan removed during native proof verification %s without a new assignment or Workflow',
  async (verification) => {
    const f = await preparedStartFixture(),
      plan = join(f.workspace, f.input.admission.plan.path),
      read = artifactFiles.readPrivateFile;
    let verified = 0;
    vi.spyOn(artifactFiles, 'readPrivateFile').mockImplementation((path) => {
      const bytes = read(path);
      if (path === f.transcript && ++verified === verification) rmSync(plan);
      return bytes;
    });
    const before = readdirSync(f.config.registration.artifactRoot);
    await expect(startPreparedLocalTask(f.workspace, f.input, f.config)).rejects.toThrow();
    expect(verified).toBeGreaterThanOrEqual(verification);
    expect(existsSync(plan)).toBe(false);
    expect(readdirSync(f.config.registration.artifactRoot)).toEqual(before);
    expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
    expect(transport.start).not.toHaveBeenCalled();
  },
);

it.each([
  'missing-plan',
  'missing-review',
  'missing-role',
  'foreign-root',
  'missing-queue',
  'foreign-thread',
  'missing-default-session-root',
])('refuses incomplete or mismatched inputs before assigning or connecting: %s', async (fault) => {
  const f = await preparedStartFixture();
  if (fault === 'missing-plan') rmSync(join(f.workspace, f.input.admission.plan.path));
  if (fault === 'missing-review') rmSync(f.store.path(f.input.admission.acceptance));
  if (fault === 'missing-role')
    f.input.admission.planning = f.save({
      ...f.request,
      phase: 'planning',
      roles: f.request.roles.slice(1),
    });
  if (fault === 'foreign-root') f.config.registration.workspaceRoot = f.root;
  if (fault === 'missing-queue') Reflect.deleteProperty(f.config, 'taskQueue');
  if (fault === 'foreign-thread') vi.stubEnv('CODEX_THREAD_ID', 'unrelated-thread');
  if (fault === 'missing-default-session-root') {
    vi.stubEnv('CODEX_HOME', undefined);
    vi.mocked(os.homedir).mockReturnValueOnce(f.root);
  }
  const before = readdirSync(f.config.registration.artifactRoot);
  await expect(startPreparedLocalTask(f.workspace, f.input, f.config)).rejects.toThrow();
  expect(readdirSync(f.config.registration.artifactRoot)).toEqual(before);
  expect(existsSync(join(f.home, 'backend-assignments'))).toBe(false);
  expect(transport.lazy).not.toHaveBeenCalled();
  expect(transport.client).not.toHaveBeenCalled();
  expect(transport.start).not.toHaveBeenCalled();
});
