import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactStore, digest } from '../src/adapters/artifacts/files.js';
import { makeTaskExecutionCommand } from '../src/client/taskExecution.js';
import { object } from '../src/contracts/project.js';
import { localTaskKey } from '../src/policy/localTask.js';
import { taskControlTarget } from '../src/policy/taskContinuation.js';
import type { ManagedTaskInput } from '../src/contracts/localTask.js';
import {
  h06TemporalControlAuthority,
  isH06TemporalAutonomousMode,
  publishH06TemporalControlSource,
  readH06TemporalControlMode,
  verifyH06TemporalControlProof,
  type H06TemporalAutonomousPhase,
} from './comparisonH06TemporalAutonomousControls.js';
const mock = vi.hoisted(() => ({ parent: {} as Record<string, unknown> }));
vi.mock('./comparisonH06TemporalAutonomousAuthority.js', () => ({
  readH06TemporalAutonomousAuthority: () => mock.parent,
}));
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(phase: H06TemporalAutonomousPhase['phase'] = 'warm-pause') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'h06-auto-controls-'));
  roots.push(root);
  const json = (name: string, value: unknown) => {
    const path = join(root, name),
      bytes = JSON.stringify(value);
    writeFileSync(path, bytes);
    return { path, sha256: digest(bytes) };
  };
  const store = artifactStore(join(root, 'artifacts'));
  const reference = store.publish(Buffer.from('{}'));
  const preparation = {
    schemaVersion: 1 as const,
    project: {
      schemaVersion: 1 as const,
      projectId: 'project',
      workspaceId: 'workspace',
      rules: ['RULES.md'],
      cardRoot: 'tasks',
      roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
      checks: ['validate'],
    },
    taskId: 'task',
    hostId: 'host',
    owner: 'owner',
    generation: 1,
    revision: 1,
    card: 'tasks/task.md',
  };
  const input: ManagedTaskInput = {
    schemaVersion: 11,
    admission: {
      schemaVersion: 3,
      preparation,
      plan: { path: 'plan.json', sha256: digest('plan') },
      planning: reference,
      acceptance: reference,
    },
    executor: { path: 'executor.md', sha256: digest('executor') },
    baseline: 'validate',
    continuation: { attempt: 0, previous: null },
  };
  const mode = { kind: 'temporal-autonomous/3', authority: json('authority.json', {}) } as const;
  const start = {
    kind: 'h06-native-temporal-start',
    controlMode: mode,
    input,
    workflowId: localTaskKey(input),
    firstExecutionRunId: 'run',
  };
  const started = json('temporal-start.json', start);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const issuer = { sessionsRoot: sessions, workspaceRoot: root, threadId: 'root', owner: 'owner' };
  const request = {
    evidenceRoot: root,
    bootstrap: json('bootstrap.json', { input }),
    chat: { threadId: 'root', workspace: root },
  };
  const parent = { request, grant: { sessionsRoot: sessions }, workDeadlineMs: Date.now() + 10000 };
  mock.parent = parent;
  const index = ['warm-pause', 'warm-resume', 'cold-pause', 'cold-resume'].indexOf(phase);
  const plan = {
    schemaVersion: 2 as const,
    commandId: 'h06-' + phase,
    target: taskControlTarget(input),
    expectedRevision: index,
    author: 'owner',
    action: phase.endsWith('pause') ? ('pause' as const) : ('resume' as const),
    attempt: [0, 1, 1, 2][index]!,
    payload: reference,
  };
  const source: H06TemporalAutonomousPhase = {
    kind: 'h06-temporal-autonomous-phase/3',
    mode,
    started,
    runId: 'run',
    phase,
  };
  const publish = () =>
    makeTaskExecutionCommand({
      ...plan,
      source: publishH06TemporalControlSource(store, source, plan),
    });
  const command = publish();
  const authority = h06TemporalControlAuthority(store, issuer, mode);
  const intent = join(root, `autonomous-${phase}-intent.json`);
  return {
    root,
    store,
    mode,
    start,
    started,
    source,
    issuer,
    parent,
    plan,
    command,
    authority,
    publish,
    json,
    intent,
  };
}

it.each(['warm-pause', 'warm-resume', 'cold-pause', 'cold-resume'] as const)(
  'derives %s honestly from the one parent grant and reuses identical intents',
  async (phase) => {
    const f = fixture(phase),
      bytes = readFileSync(f.intent);
    expect(f.publish()).toEqual(f.command);
    expect(await f.authority.issue(f.command)).toContain('h06-temporal-derived-command/3');
    const result = await f.authority.verify(f.command);
    expect(result.origin).toBe('initial-grant');
    expect(result.author).toBe('owner');
    expect(result.hash).toBe(f.command.hash);
    const proof = object(JSON.parse(f.store.read(result.proof).toString()));
    verifyH06TemporalControlProof(f.store, f.mode, f.command, proof);
    f.parent.workDeadlineMs = 1;
    verifyH06TemporalControlProof(f.store, f.mode, f.command, proof);
    expect(readFileSync(f.intent)).toEqual(bytes);
  },
);

it.each([undefined, null, 'mode', {}, { kind: 'manual' }])(
  'does not mistake %j for the tagged autonomous mode',
  (value) => {
    expect(isH06TemporalAutonomousMode(value)).toBe(false);
  },
);
it('recognizes only the explicit autonomous tag and validates its shape', () => {
  const f = fixture();
  expect(isH06TemporalAutonomousMode(f.mode)).toBe(true);
  expect(readH06TemporalControlMode(f.mode)).toEqual(f.mode);
  expect(() => readH06TemporalControlMode({ ...f.mode, extra: true })).toThrow();
  expect(() => readH06TemporalControlMode({ ...f.mode, kind: 'manual' })).toThrow(
    'h06-temporal-control-mode',
  );
});
it('retains the original manual authority and manual source format', async () => {
  const f = fixture();
  const manual = h06TemporalControlAuthority(f.store, f.issuer);
  const source = {
    schemaVersion: 1 as const,
    kind: 'codex-user-command' as const,
    transcript: join(f.root, 'manual.jsonl'),
    threadId: 'root',
    turnId: 'turn',
    user: { line: 1, sha256: digest('user') },
  };
  const ref = publishH06TemporalControlSource(f.store, source, f.plan);
  expect(JSON.parse(f.store.read(ref).toString())).toEqual(source);
  const command = makeTaskExecutionCommand({ ...f.plan, source: ref });
  verifyH06TemporalControlProof(f.store, undefined, command, {
    kind: 'reader-native-human-authorization',
    command,
    source,
  });
  expect(() =>
    verifyH06TemporalControlProof(f.store, undefined, command, { kind: 'fake' }),
  ).toThrow('h06-temporal-control-proof');
  await expect(manual.issue(command)).rejects.toThrow();
});
it('rejects a forged command hash', async () => {
  const f = fixture();
  await expect(f.authority.issue({ ...f.command, hash: digest('other') })).rejects.toThrow(
    'h06-temporal-control-command',
  );
});
it.each(['threadId', 'workspaceRoot', 'sessionsRoot', 'owner'] as const)(
  'rejects issuer %s mismatch',
  async (field) => {
    const f = fixture();
    const issuer = { ...f.issuer, [field]: 'other' };
    await expect(
      h06TemporalControlAuthority(f.store, issuer, f.mode).issue(f.command),
    ).rejects.toThrow('h06-temporal-control-issuer');
  },
);
it('refuses live execution after the parent deadline', async () => {
  const f = fixture();
  f.parent.workDeadlineMs = 1;
  expect(() => f.publish()).toThrow('h06-temporal-control-deadline');
  await expect(f.authority.issue(f.command)).rejects.toThrow('h06-temporal-control-deadline');
  await expect(f.authority.verify(f.command)).rejects.toThrow('h06-temporal-control-deadline');
});
it('rejects an unrecognized phase before publishing any path', () => {
  const f = fixture();
  Object.assign(f.source, { phase: '../escape' });
  expect(() => f.publish()).toThrow('h06-temporal-control-phase');
});
it('does not overwrite a phase with a different command', () => {
  const f = fixture(),
    before = readFileSync(f.intent);
  f.plan.payload = f.store.publish(Buffer.from('changed'));
  expect(() => f.publish()).toThrow();
  expect(readFileSync(f.intent)).toEqual(before);
});
it('rejects a different immutable phase intent', async () => {
  const f = fixture();
  writeFileSync(f.intent, 'changed');
  await expect(f.authority.issue(f.command)).rejects.toThrow();
});
it('rejects a forged authorization proof', async () => {
  const f = fixture(),
    result = await f.authority.verify(f.command);
  const proof = object(JSON.parse(f.store.read(result.proof).toString()));
  proof.kind = 'reader-native-human-authorization';
  expect(() => verifyH06TemporalControlProof(f.store, f.mode, f.command, proof)).toThrow(
    'h06-temporal-control-proof',
  );
});
it.each([
  'kind',
  'mode',
  'path',
  'start-kind',
  'start-mode',
  'input',
  'workflow',
  'source-workflow',
  'run',
  'target',
  'author',
  'commandId',
  'action',
  'revision',
  'attempt',
  'source-command',
  'unknown-phase',
] as const)('rejects %s rebinding', async (kind) => {
  const f = fixture();
  const source = JSON.parse(f.store.read(f.command.source).toString()) as Record<string, unknown>;
  let command = { ...f.command };
  if (kind === 'kind') source.kind = 'fake';
  if (kind === 'mode') source.mode = { ...f.mode, authority: f.json('other-authority.json', {}) };
  if (kind === 'path') source.started = f.json('other-start.json', f.start);
  if (kind === 'start-kind') f.start.kind = 'wrong';
  if (kind === 'start-mode') Object.assign(f.start, { controlMode: {} });
  if (kind === 'input') Object.assign(f.start.input, { baseline: 'other' });
  if (kind === 'workflow') f.start.workflowId = 'other';
  if (['start-kind', 'start-mode', 'input', 'workflow'].includes(kind))
    source.started = f.json('temporal-start.json', f.start);
  if (kind === 'source-workflow') source.workflowId = 'other';
  if (kind === 'run') source.runId = 'other';
  if (kind === 'target') command = { ...command, target: { ...command.target, taskId: 'other' } };
  if (kind === 'author') command.author = 'other';
  if (kind === 'commandId') command.commandId = 'other';
  if (kind === 'action') command.action = 'resume';
  if (kind === 'revision') command.expectedRevision = 1;
  if (kind === 'attempt') command.attempt = 1;
  if (kind === 'source-command') source.command = {};
  if (kind === 'unknown-phase') source.phase = 'other';
  const bytes = Buffer.from(JSON.stringify(source));
  writeFileSync(f.intent, bytes);
  command = makeTaskExecutionCommand({ ...command, source: f.store.publish(bytes) });
  await expect(f.authority.issue(command)).rejects.toThrow(
    kind === 'unknown-phase' ? 'h06-temporal-control-phase' : 'h06-temporal-control-binding',
  );
});
