import { Client } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';
import {
  controlTaskExecution,
  makeTaskExecutionCommand,
  controlTaskHuman,
  queryTaskHuman,
  prepareTaskHumanAsk,
  prepareTaskHumanQuestion,
  prepareTaskHumanDecision,
  makeTaskHumanWaitResumeCommand,
} from '../../src/client/taskExecution.js';
import type { HumanManagedTaskInput } from '../../src/contracts/localTask.js';
import type {
  TaskHumanCommandContext,
  TaskHumanCommand,
  TaskHumanTarget,
} from '../../src/contracts/taskHuman.js';
import { createTaskHumanState, taskHumanCommandText } from '../../src/policy/taskHuman.js';
import {
  nativeHumanContext,
  nativeHumanQuestion,
} from '../../src/adapters/codex/nativeHumanChoice.js';
import type { NativeHumanContext } from '../../src/adapters/codex/nativeHumanChoice.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { readerCommandText } from '../../src/policy/readerControl.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { controlFixture } from './controlFixture.js';

describe('task control client payload and acknowledgement binding', () => {
  it('sends the exact hashed payload and rejects substituted requests or acknowledgements', async () => {
    const f = controlFixture(),
      target = { ...f.command().target, roleId: 'task' },
      command = makeTaskExecutionCommand({
        ...f.command(),
        schemaVersion: 2,
        target,
        payload: f.proof,
      }),
      ack = {
        commandId: command.commandId,
        hash: command.hash,
        revision: command.expectedRevision + 1,
        authorization: f.proof,
      },
      client = bindTaskBackendClient(new Client(), f.registration),
      handle = client.workflow.getHandle(target.workflowId),
      get = vi.spyOn(client.workflow, 'getHandle').mockReturnValue(handle),
      update = vi.spyOn(handle, 'executeUpdate').mockResolvedValue(ack);
    try {
      expect(command.hash).toBe(digest(readerCommandText(command)));
      expect(await controlTaskExecution(client, target.workflowId, command)).toEqual(ack);
      expect(update).toHaveBeenCalledWith('taskExecutionControl', { args: [command] });
      for (const value of [
        { ...command, hash: 'a'.repeat(64) },
        { ...command, payload: f.save({ substituted: true }) },
        { ...command, target: { ...target, roleId: 'reader' } },
      ])
        await expect(controlTaskExecution(client, target.workflowId, value)).rejects.toThrow(
          'task-command-hash-invalid',
        );
      await expect(
        controlTaskExecution(client, target.workflowId + '-other', command),
      ).rejects.toThrow('task-command-hash-invalid');
      expect(update).toHaveBeenCalledTimes(1);
      expect(await controlTaskExecution(client, target.workflowId, command, 'pinned-run')).toEqual(
        ack,
      );
      expect(get).toHaveBeenLastCalledWith(target.workflowId, 'pinned-run');
      for (const changed of [
        { ...ack, commandId: 'other' },
        { ...ack, hash: '0'.repeat(64) },
        { ...ack, revision: ack.revision + 1 },
      ]) {
        update.mockResolvedValueOnce(changed);
        await expect(controlTaskExecution(client, target.workflowId, command)).rejects.toThrow(
          'task-command-receipt-invalid',
        );
      }
      expect(() =>
        makeTaskExecutionCommand({ ...command, target: { ...target, roleId: 'reader' } }),
      ).toThrow('task-command-action');
    } finally {
      get.mockRestore();
      update.mockRestore();
      await client.connection.close();
    }
  });
});

function humanFixture() {
  const f = controlFixture(),
    target: TaskHumanTarget = { ...f.command().target, roleId: 'task' },
    manifest = {
      schemaVersion: 1 as const,
      kind: 'task-human-gate-manifest' as const,
      target,
      card: { path: 'tasks/one.md', ...f.proof },
      requirements: f.proof,
      declaration: f.proof,
      criteria: [
        {
          id: 'C1: принято',
          text: 'Проверить результат',
          kind: 'human' as const,
          applicable: true,
          reason: 'unit client',
        },
      ],
    },
    input: HumanManagedTaskInput = {
      schemaVersion: 12,
      admission: {
        schemaVersion: 3,
        preparation: f.input.preparation,
        plan: { path: 'tasks/one.md', sha256: f.proof.sha256 },
        planning: f.proof,
        acceptance: f.proof,
      },
      executor: { path: 'reviewer.md', sha256: f.proof.sha256 },
      baseline: 'syntax',
      continuation: { attempt: 0, previous: null },
      startAdmission: f.proof,
    },
    context: TaskHumanCommandContext = {
      input,
      state: createTaskHumanState({ manifest, ref: f.proof }),
      technical: {
        input,
        snapshot: f.proof,
        packet: {
          schemaVersion: 1,
          preparation: f.input.preparation,
          reviewId: f.proof.sha256,
          request: f.proof,
        },
        acceptance: f.proof,
        records: [f.proof],
        stopped: f.proof,
      },
    },
    unsigned: TaskHumanCommand = {
      schemaVersion: 1,
      commandId: 'ask',
      hash: '0'.repeat(64),
      target,
      manifest: f.proof,
      expectedRevision: 0,
      author: target.owner,
      source: f.proof,
      questionId: 'q',
      criterionId: manifest.criteria[0]!.id,
      action: 'ASK',
    },
    command = { ...unsigned, hash: digest(taskHumanCommandText(unsigned)) };
  return { ...f, target, context, command };
}
describe('task human SDK separate Update and durable context query', () => {
  it('builds a held-free human-wait RESUME without repeating a Writer attempt for unchanged requirements', () => {
    const f = humanFixture(),
      input = f.context.input,
      fields = {
        commandId: 'resume',
        expectedRevision: 4,
        author: input.admission.preparation.owner,
        source: f.proof,
      },
      same = {
        schemaVersion: 2 as const,
        kind: 'task-human-wait-resume' as const,
        admission: input.admission,
        startAdmission: input.startAdmission,
      },
      command = makeTaskHumanWaitResumeCommand(input, fields, same, f.store);
    expect(command.action).toBe('resume');
    expect(command.attempt).toBe(input.continuation.attempt);
    expect(JSON.parse(f.store.read(command.payload).toString('utf8'))).toEqual(same);
    expect(command.hash).toBe(digest(readerCommandText(command)));
    const changed = {
      ...same,
      admission: { ...same.admission, preparation: { ...same.admission.preparation, revision: 2 } },
      startAdmission: f.save({ new: 'requirements' }),
    };
    expect(makeTaskHumanWaitResumeCommand(input, fields, changed, f.store).attempt).toBe(
      input.continuation.attempt + 1,
    );
    expect(() =>
      makeTaskHumanWaitResumeCommand(input, { ...fields, author: 'foreign' }, same, f.store),
    ).toThrow('resume-author');
    expect(() =>
      makeTaskHumanWaitResumeCommand(
        input,
        fields,
        { ...same, startAdmission: changed.startAdmission },
        f.store,
      ),
    ).toThrow('declaration-revision');
  });
  it('binds human update/hash/receipt and keeps retained duplicate acknowledgement valid', async () => {
    const f = humanFixture(),
      client = bindTaskBackendClient(new Client(), f.registration),
      handle = client.workflow.getHandle(f.target.workflowId),
      get = vi.spyOn(client.workflow, 'getHandle').mockReturnValue(handle),
      receipt = {
        commandId: f.command.commandId,
        hash: f.command.hash,
        revision: 1,
        requirementsRevision: 1,
        proof: f.proof,
      },
      update = vi.spyOn(handle, 'executeUpdate').mockResolvedValue(receipt);
    try {
      expect(await controlTaskHuman(client, f.target.workflowId, f.command)).toEqual(receipt);
      expect(update).toHaveBeenLastCalledWith('taskHuman', { args: [f.command] });
      expect(
        await controlTaskHuman(client, f.target.workflowId, f.command, 'retained-run'),
      ).toEqual(receipt);
      expect(get).toHaveBeenLastCalledWith(f.target.workflowId, 'retained-run');
      for (const command of [
        { ...f.command, hash: '0'.repeat(64) },
        { ...f.command, source: { ...f.proof, bytes: f.proof.bytes + 1 } },
        { ...f.command, target: { ...f.target, roleId: 'reader' } },
      ])
        await expect(controlTaskHuman(client, f.target.workflowId, command)).rejects.toThrow();
      await expect(controlTaskHuman(client, 'foreign', f.command)).rejects.toThrow('command-hash');
      expect(update).toHaveBeenCalledTimes(2);
      for (const altered of [
        { ...receipt, commandId: 'other' },
        { ...receipt, hash: '0'.repeat(64) },
        { ...receipt, revision: 2 },
        { ...receipt, requirementsRevision: 2 },
        { ...receipt, proof: { ...f.proof, bytes: -1 } },
      ]) {
        update.mockResolvedValueOnce(altered);
        await expect(controlTaskHuman(client, f.target.workflowId, f.command)).rejects.toThrow();
      }
      const unbound = new Client();
      try {
        await expect(controlTaskHuman(unbound, f.target.workflowId, f.command)).rejects.toThrow(
          'backend-client-unbound',
        );
      } finally {
        await unbound.connection.close();
      }
    } finally {
      get.mockRestore();
      await client.connection.close();
    }
  });
  it('queries actual durable state before issuer helpers and refuses foreign/not-ready context', async () => {
    const f = humanFixture(),
      client = bindTaskBackendClient(new Client(), f.registration),
      handle = client.workflow.getHandle(f.target.workflowId),
      get = vi.spyOn(client.workflow, 'getHandle').mockReturnValue(handle),
      query = vi.spyOn(handle, 'query').mockResolvedValue(f.context),
      ask = vi.fn(async () => f.command),
      decision = vi.fn(async () => f.command),
      ctx: NativeHumanContext = {
        kind: 'task-human-choice-context/1',
        questionId: 'q',
        criterion: { id: 'C1: принято', text: 'Проверить результат' },
        target: f.target,
        expectedHumanRevision: 1,
        manifest: f.proof,
        card: { path: 'tasks/one.md', ...f.proof },
        candidate: f.proof,
        technicalAcceptance: f.proof,
        chat: { threadId: 'unit', workspace: f.workspace, hostId: 'local' },
        author: f.target.owner,
      },
      bound = nativeHumanContext(ctx),
      contextRef = f.store.publish(Buffer.from(bound.body)),
      links = {
        context: { ...contextRef, path: f.store.path(contextRef) },
        result: { ...f.proof, path: f.store.path(f.proof) },
      },
      prepared = { context: ctx, links, ...nativeHumanQuestion(ctx, links) },
      prepare = vi.fn(async () => prepared),
      fields = { commandId: 'ask', questionId: 'q', criterionId: 'C1: принято' },
      references = {
        call: { locator: 'unit://call', hash: 'a'.repeat(64) },
        publication: { locator: 'unit://pub', hash: 'a'.repeat(64) },
        reply: { locator: 'unit://reply', hash: 'a'.repeat(64) },
        delivery: { locator: 'unit://delivery', hash: 'a'.repeat(64) },
      };
    try {
      expect(await queryTaskHuman(client, f.target.workflowId, f.target)).toBe(f.context);
      expect(query).toHaveBeenCalledWith('taskHumanState');
      expect(
        await prepareTaskHumanAsk(
          client,
          f.target.workflowId,
          f.target,
          { prepareAsk: ask },
          fields,
          'run',
        ),
      ).toBe(f.command);
      expect(ask).toHaveBeenCalledWith(f.context, fields);
      expect(get).toHaveBeenLastCalledWith(f.target.workflowId, 'run');
      expect(
        await prepareTaskHumanQuestion(client, f.target.workflowId, f.target, {
          prepareQuestion: prepare,
        }),
      ).toBe(prepared);
      expect(prepare).toHaveBeenCalledWith(f.context);
      const source = { commandId: 'yes', transcript: '/synthetic/native.jsonl', references };
      expect(
        await prepareTaskHumanDecision(
          client,
          f.target.workflowId,
          f.target,
          { makeDecision: decision },
          source,
        ),
      ).toBe(f.command);
      expect(decision).toHaveBeenCalledWith(f.context, source);
      query.mockResolvedValueOnce(null);
      expect(await queryTaskHuman(client, f.target.workflowId, f.target)).toBeNull();
      query.mockResolvedValueOnce(null);
      await expect(
        prepareTaskHumanQuestion(client, f.target.workflowId, f.target, {
          prepareQuestion: prepare,
        }),
      ).rejects.toThrow('not-ready');
      expect(prepare).toHaveBeenCalledTimes(1);
      const changed = structuredClone(f.context);
      changed.state.current.manifest.target.generation++;
      query.mockResolvedValueOnce(changed);
      await expect(queryTaskHuman(client, f.target.workflowId, f.target)).rejects.toThrow(
        'query-context',
      );
      await expect(queryTaskHuman(client, 'foreign', f.target)).rejects.toThrow('query-target');
    } finally {
      get.mockRestore();
      await client.connection.close();
    }
  });
});
