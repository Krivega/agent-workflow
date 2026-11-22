import { expect, it } from 'vitest';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type { TaskHumanExecutionResume } from '../../src/contracts/taskHuman.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { parseSubstantialAdmission } from '../../src/policy/substantialTask.js';
import {
  parseTaskExecutionResume,
  checkTaskExecutionResume,
  parseTaskHumanExecutionResume,
  checkTaskHumanExecutionResume,
  parseTaskHumanWaitResume,
  checkTaskHumanWaitResume,
  taskHumanExecutionCommand,
  taskInterruption,
  taskExecutionDiagnostics,
} from '../../src/policy/taskExecution.js';

const ref = { sha256: 'a'.repeat(64), bytes: 10 };
const input: HumanManagedTaskInput = {
  schemaVersion: 12,
  admission: {
    schemaVersion: 3,
    preparation: {
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        projectId: 'project',
        workspaceId: 'workspace',
        rules: ['RULES.md'],
        cardRoot: 'tasks',
        roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
        checks: ['syntax'],
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
  executor: { path: 'executor.md', sha256: ref.sha256 },
  baseline: 'syntax',
  continuation: { attempt: 0, previous: null },
  startAdmission: ref,
};
input.admission = parseSubstantialAdmission(input.admission);
const next = { ...input.admission, preparation: { ...input.admission.preparation, revision: 2 } };
it('keeps interruption and retained diagnostic parsing strict across input versions', () => {
  expect(taskInterruption({ schemaVersion: 1, kind: 'task-interruption', reason: 'pause' })).toBe(
    'pause',
  );
  expect(() =>
    taskInterruption({ schemaVersion: 2, kind: 'task-interruption', reason: 'pause' }),
  ).toThrow();
  expect(() => taskInterruption({ schemaVersion: 1, kind: 'other', reason: 'pause' })).toThrow();
  expect(taskExecutionDiagnostics([{ phase: 'checkpoint-unknown', error: 'unavailable' }])).toEqual(
    [{ phase: 'checkpoint-unknown', error: 'unavailable' }],
  );
  for (const value of [null, [{ phase: 0, error: 'x' }], [{ phase: 'x', error: 0 }]])
    expect(() => taskExecutionDiagnostics(value)).toThrow();
});
it('keeps v1 resume bytes and rejects declaration downgrade while v12 changes only through requirements', () => {
  const legacy = {
    schemaVersion: 1,
    kind: 'task-execution-resume',
    held: ref,
    admission: input.admission,
  };
  expect(JSON.stringify(parseTaskExecutionResume(legacy))).toBe(JSON.stringify(legacy));
  checkTaskExecutionResume({ ...input, schemaVersion: 11 }, parseTaskExecutionResume(legacy));
  expect(() =>
    checkTaskHumanExecutionResume(input, legacy as unknown as TaskHumanExecutionResume),
  ).toThrow('human-resume-admission-required');
  const raw = { ...legacy, schemaVersion: 2, startAdmission: ref };
  const current = parseTaskHumanExecutionResume(raw);
  checkTaskHumanExecutionResume(input, current);
  expect(current.held).toEqual(ref);
  expect(() => parseTaskExecutionResume(raw)).toThrow('unexpected-fields');
  expect(() => parseTaskExecutionResume({ ...legacy, schemaVersion: 2 })).toThrow(
    'task-execution-payload',
  );
  expect(() => parseTaskHumanExecutionResume({ ...raw, schemaVersion: 1 })).toThrow(
    'human-execution-resume-payload',
  );
  expect(() => parseTaskHumanExecutionResume({ ...raw, kind: 'task-human-wait-resume' })).toThrow(
    'human-execution-resume-payload',
  );
  expect(() => parseTaskHumanExecutionResume({ ...raw, held: null })).toThrow();
  expect(() => parseTaskHumanExecutionResume({ ...raw, startAdmission: null })).toThrow();
  expect(() => checkTaskHumanExecutionResume(input, { ...current, admission: next })).toThrow(
    'human-resume-declaration-revision',
  );
  checkTaskHumanExecutionResume(input, {
    ...current,
    schemaVersion: 2,
    admission: next,
    startAdmission: { ...ref, sha256: 'b'.repeat(64) },
  });
  expect(() =>
    checkTaskHumanExecutionResume(input, { ...current, startAdmission: { ...ref, bytes: 11 } }),
  ).toThrow('human-resume-declaration-revision');
  expect(() =>
    checkTaskHumanExecutionResume(input, {
      ...current,
      admission: { ...next, preparation: { ...next.preparation, taskId: 'foreign' } },
    }),
  ).toThrow('task-resume-scope-changed');
  expect(() => parseTaskExecutionResume({ ...legacy, schemaVersion: 3 })).toThrow();
});
it('validates held-free human resumes without inventing held state or widening the task scope', () => {
  const raw = {
    schemaVersion: 2,
    kind: 'task-human-wait-resume',
    admission: input.admission,
    startAdmission: ref,
  };
  expect(checkTaskHumanWaitResume(input, parseTaskHumanWaitResume(raw))).toBe(false);
  expect(
    checkTaskHumanWaitResume(
      input,
      parseTaskHumanWaitResume({ ...raw, admission: next, startAdmission: { ...ref, bytes: 11 } }),
    ),
  ).toBe(true);
  expect(() =>
    checkTaskHumanWaitResume(input, { ...parseTaskHumanWaitResume(raw), admission: next }),
  ).toThrow('human-resume-declaration-revision');
  expect(() => parseTaskHumanWaitResume({ ...raw, held: ref })).toThrow();
  expect(() => parseTaskHumanWaitResume({ ...raw, schemaVersion: 1 })).toThrow();
});
it('keeps human-only control attempt fixed and permits a distinct next attempt only for verified resume', () => {
  const command = {
    schemaVersion: 2,
    commandId: 'pause',
    target: taskControlTarget(input),
    expectedRevision: 0,
    author: 'owner',
    action: 'pause',
    attempt: 0,
    source: ref,
    payload: ref,
    hash: ref.sha256,
  };
  expect(taskHumanExecutionCommand(input, command, 0)).toMatchObject({ attempt: 0 });
  expect(
    taskHumanExecutionCommand(input, { ...command, action: 'resume', attempt: 1 }, 0),
  ).toMatchObject({ attempt: 1 });
  for (const bad of [
    { ...command, author: 'other' },
    { ...command, expectedRevision: 1 },
    { ...command, attempt: 1 },
    { ...command, action: 'resume', attempt: 2 },
    { ...command, target: { ...command.target, taskId: 'other' } },
  ])
    expect(() => taskHumanExecutionCommand(input, bad, 0)).toThrow();
  expect(() =>
    taskHumanExecutionCommand(
      input,
      { ...command, expectedRevision: Number.MAX_SAFE_INTEGER },
      Number.MAX_SAFE_INTEGER,
    ),
  ).toThrow('task-command-stale');
});
