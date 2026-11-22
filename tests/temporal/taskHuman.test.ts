import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TaskHumanCommand,
  TaskHumanState,
  VerifiedTaskHumanCommand,
} from '../../src/contracts/taskHuman.js';
import {
  advanceTaskHumanRequirements,
  applyTaskHumanCommand,
  checkTaskHumanCommand,
  closeTaskHuman,
  createTaskHumanState,
  parseBoundTaskHumanManifest,
  parseTaskHumanCommand,
  parseTaskHumanCriterion,
  parseTaskHumanManifest,
  parseTaskHumanTarget,
  retainedTaskHumanReceipt,
  taskHumanBlockers,
  taskHumanCanonical,
  taskHumanCommandText,
} from '../../src/policy/taskHuman.js';

const ref = (letter = 'a') => ({ sha256: letter.repeat(64), bytes: 10 });
function fixture() {
  return createTaskHumanState({
    ref: ref(),
    manifest: {
      schemaVersion: 1,
      kind: 'task-human-gate-manifest',
      target: {
        workflowId: 'aw/task/project/task',
        projectId: 'project',
        taskId: 'task',
        roleId: 'task',
        hostId: 'host',
        workspaceId: 'workspace',
        owner: 'owner',
        generation: 1,
        requirementsRevision: 1,
      },
      card: { path: 'tasks/task.md', ...ref() },
      requirements: ref(),
      declaration: ref(),
      criteria: [
        {
          id: ' C1: результат проверен ',
          text: 'Результат проверен человеком',
          kind: 'human',
          applicable: true,
          reason: 'Explicit owner criterion',
        },
        { id: 'C2', text: 'Optional', kind: 'human', applicable: false, reason: 'Not applicable' },
        {
          id: 'validate',
          text: 'Tests',
          kind: 'check',
          applicable: true,
          reason: 'Independent check',
        },
      ],
    },
  });
}
function command(
  state: TaskHumanState,
  action: 'ASK' | 'DECIDE' = 'ASK',
  accepted = true,
): TaskHumanCommand {
  const fields = {
    schemaVersion: 1 as const,
    commandId: action.toLowerCase() + state.revision,
    hash: ref().sha256,
    target: state.current.manifest.target,
    manifest: state.current.ref,
    expectedRevision: state.revision,
    author: 'owner',
    source: ref(),
    questionId: state.pending?.questionId ?? 'question' + state.revision,
    criterionId: ' C1: результат проверен ',
  };
  return action === 'ASK' ? { ...fields, action } : { ...fields, action, accepted };
}
function verified(value: TaskHumanCommand): VerifiedTaskHumanCommand {
  return value.action === 'ASK'
    ? { kind: 'verified-task-human-command', action: 'ASK', command: value, proof: ref('b') }
    : {
        kind: 'verified-task-human-command',
        action: 'DECIDE',
        command: value,
        accepted: value.accepted,
        proof: ref('b'),
      };
}
function apply(state: TaskHumanState, action: 'ASK' | 'DECIDE', accepted = true) {
  const value = command(state, action, accepted);
  return { ...applyTaskHumanCommand(state, value, verified(value)), command: value };
}

afterEach(() => vi.unstubAllGlobals());

describe('deterministic human gates with trusted Activity verification', () => {
  it('copies JSON state without structuredClone and isolates nested state through commands, closing and requirements', () => {
    vi.stubGlobal('structuredClone', undefined);
    const initial = fixture(),
      initialBefore = taskHumanCanonical(initial),
      asked = apply(initial, 'ASK').state,
      askedBefore = taskHumanCanonical(asked),
      approved = apply(asked, 'DECIDE').state,
      approvedBefore = taskHumanCanonical(approved),
      closed = closeTaskHuman(approved, approved.revision);
    closed.current.manifest.criteria[0]!.text = 'Changed returned criterion';
    closed.decisions[0]!.source.bytes++;
    closed.history[0]!.receipt.proof.bytes++;
    expect(taskHumanCanonical(initial)).toBe(initialBefore);
    expect(taskHumanCanonical(asked)).toBe(askedBefore);
    expect(taskHumanCanonical(approved)).toBe(approvedBefore);
    const next = parseBoundTaskHumanManifest(approved.current);
    next.ref = ref('c');
    next.manifest.target.requirementsRevision = 2;
    const advanced = advanceTaskHumanRequirements(approved, {
      kind: 'verified-task-human-requirements',
      commandId: 'requirements2',
      hash: ref('b').sha256,
      previousManifest: approved.current.ref,
      next,
      expectedRevision: approved.revision,
      source: ref('d'),
      proof: ref('b'),
    });
    advanced.current.manifest.criteria[0]!.text = 'Changed new criterion';
    advanced.decisions[0]!.receipt.proof.bytes++;
    advanced.history[0]!.receipt.proof.bytes++;
    const requirements = advanced.history.at(-1)!;
    expect(requirements.kind).toBe('requirements');
    if (requirements.kind === 'requirements') requirements.previousManifest.bytes++;
    expect(taskHumanCanonical(approved)).toBe(approvedBefore);
    expect(next.manifest.criteria[0]!.text).toBe(initial.current.manifest.criteria[0]!.text);
  });

  it('keeps opaque Unicode and long text intact without crypto or byte encoding', () => {
    const state = fixture(),
      manifest = structuredClone(state.current.manifest);
    manifest.criteria[0] = {
      ...manifest.criteria[0]!,
      id: 'Критерий '.repeat(5000),
      text: 'Описание '.repeat(5000),
      reason: ' Причина ',
    };
    expect(parseTaskHumanManifest(manifest)).toEqual(manifest);
    expect(taskHumanCanonical({ b: [null, true, { z: 1, a: 'x' }], a: 0 })).toBe(
      '{"a":0,"b":[null,true,{"a":"x","z":1}]}',
    );
    const value = command(state);
    expect(JSON.parse(taskHumanCommandText(value))).toEqual(
      (({ hash: _hash, ...body }) => body)(value),
    );
    expect(parseBoundTaskHumanManifest(state.current)).toEqual(state.current);
  });
  it('requires current consent, re-ASK revokes it, false stays false and receipts remain historical', () => {
    let state = fixture();
    expect(taskHumanBlockers(state)).toEqual([' C1: результат проверен ']);
    expect(() => closeTaskHuman(state, 0)).toThrow('human-gates-open');
    const asked = apply(state, 'ASK');
    state = asked.state;
    expect(state.pending?.askedRevision).toBe(1);
    expect(() => checkTaskHumanCommand(state, { ...command(state), questionId: 'other' })).toThrow(
      'human-question-pending',
    );
    const decided = apply(state, 'DECIDE');
    state = decided.state;
    expect(taskHumanBlockers(state)).toEqual([]);
    state = apply(state, 'ASK').state;
    expect(taskHumanBlockers(state)).toHaveLength(1);
    state = apply(state, 'DECIDE', false).state;
    expect(taskHumanBlockers(state)).toHaveLength(1);
    state = apply(state, 'ASK').state;
    state = apply(state, 'DECIDE').state;
    state = closeTaskHuman(state, state.revision);
    expect(applyTaskHumanCommand(state, decided.command, verified(decided.command))).toEqual({
      state,
      receipt: decided.receipt,
    });
    expect(() => checkTaskHumanCommand(state, command(state))).toThrow('human-closed');
    expect(() => closeTaskHuman(state, state.revision)).toThrow('human-stale');
    expect(() =>
      retainedTaskHumanReceipt(state, { ...decided.command, hash: ref('c').sha256 }),
    ).toThrow('human-command-conflict');
  });
  it('rejects stale or foreign commands before verification and never accepts caller outcome alone', () => {
    const state = fixture(),
      value = command(state);
    for (const invalid of [
      { ...value, expectedRevision: 1 },
      { ...value, author: 'other' },
      { ...value, manifest: ref('c') },
      { ...value, target: { ...value.target, taskId: 'other' } },
      { ...value, criterionId: 'validate' },
      { ...value, criterionId: 'C2' },
    ])
      expect(() => checkTaskHumanCommand(state, invalid)).toThrow();
    expect(() =>
      checkTaskHumanCommand(
        { ...state, revision: Number.MAX_SAFE_INTEGER },
        { ...value, expectedRevision: Number.MAX_SAFE_INTEGER },
      ),
    ).toThrow('human-stale');
    expect(() => checkTaskHumanCommand(state, command(state, 'DECIDE'))).toThrow(
      'human-question-binding',
    );
    const asked = apply(state, 'ASK'),
      decided = command(asked.state, 'DECIDE');
    expect(() =>
      applyTaskHumanCommand(asked.state, decided, {
        ...verified(decided),
        accepted: false,
      } as VerifiedTaskHumanCommand),
    ).toThrow('human-decision-unconfirmed');
    expect(() =>
      applyTaskHumanCommand(state, value, {
        ...verified(value),
        command: { ...value, source: ref('d') },
      }),
    ).toThrow('human-verification-binding');
    const done = apply(asked.state, 'DECIDE');
    expect(() =>
      checkTaskHumanCommand(done.state, { ...command(done.state), questionId: value.questionId }),
    ).toThrow('human-question-reused');
    expect(() => retainedTaskHumanReceipt(done.state, { ...value, source: ref('c') })).toThrow(
      'human-command-conflict',
    );
    expect(() => checkTaskHumanCommand(asked.state, { ...decided, questionId: 'other' })).toThrow(
      'human-question-binding',
    );
    expect(() =>
      checkTaskHumanCommand(asked.state, {
        ...decided,
        target: { ...decided.target, requirementsRevision: 2 },
      }),
    ).toThrow('human-command-binding');
  });
  it('retains history but invalidates approvals when verified requirements advance', () => {
    const original = apply(apply(fixture(), 'ASK').state, 'DECIDE').state;
    const next = structuredClone(original.current);
    next.ref = ref('c');
    next.manifest.target.requirementsRevision = 2;
    const transition = {
      kind: 'verified-task-human-requirements' as const,
      commandId: 'requirements2',
      hash: ref('b').sha256,
      previousManifest: original.current.ref,
      next,
      expectedRevision: original.revision,
      source: ref('d'),
      proof: ref('b'),
    };
    const state = advanceTaskHumanRequirements(original, transition);
    expect(state.decisions).toEqual(original.decisions);
    expect(state.pending).toBeNull();
    expect(taskHumanBlockers(state)).toHaveLength(1);
    expect(() =>
      advanceTaskHumanRequirements(original, { ...transition, expectedRevision: 99 }),
    ).toThrow('human-stale');
    expect(() =>
      advanceTaskHumanRequirements(original, { ...transition, previousManifest: ref('e') }),
    ).toThrow('human-requirements-binding');
    expect(() =>
      advanceTaskHumanRequirements(original, { ...transition, next: original.current }),
    ).toThrow('human-requirements-target');
    expect(() =>
      advanceTaskHumanRequirements(original, {
        ...transition,
        commandId: original.history[0]!.receipt.commandId,
      }),
    ).toThrow('human-command-conflict');
    const empty = structuredClone(next);
    empty.manifest.criteria = [];
    expect(taskHumanBlockers(createTaskHumanState(empty))).toEqual([]);
  });
  it('rejects incomplete criteria, invented versions and malformed identities', () => {
    const state = fixture(),
      manifest = state.current.manifest,
      value = command(state);
    for (const invalid of [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, criteria: null },
      { ...manifest, criteria: [manifest.criteria[0], manifest.criteria[0]] },
      { ...manifest, extra: true },
      { ...manifest, card: { ...manifest.card, path: '../other' } },
    ])
      expect(() => parseTaskHumanManifest(invalid)).toThrow();
    for (const invalid of [
      { ...manifest.criteria[0], kind: 'other' },
      { ...manifest.criteria[0], applicable: null },
      { ...manifest.criteria[0], id: ' ' },
      { ...manifest.criteria[0], text: '' },
    ])
      expect(() => parseTaskHumanCriterion(invalid)).toThrow();
    for (const invalid of [
      { ...manifest.target, roleId: 'reader' },
      { ...manifest.target, generation: 0 },
      { ...manifest.target, requirementsRevision: 0 },
      { ...manifest.target, runId: 'invented' },
    ])
      expect(() => parseTaskHumanTarget(invalid)).toThrow();
    for (const invalid of [
      { ...value, action: 'PASS' },
      { ...value, schemaVersion: 2 },
      { ...value, commandId: ' ' },
      { ...value, expectedRevision: -1 },
      { ...value, action: 'DECIDE', accepted: 'true' },
      { ...value, accepted: true },
    ])
      expect(() => parseTaskHumanCommand(invalid)).toThrow();
  });
});
