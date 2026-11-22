import type { Client } from '@temporalio/client';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTaskFixture } from './localTaskFixture.js';
import {
  bindTaskBackendClient,
  requireClientTaskBackend,
  reserveNewTaskBackend,
} from '../../src/client/taskBackend.js';
import { reserveTaskBackend, taskBackendHome } from '../../src/adapters/project/taskBackend.js';
import { startPreparation } from '../../src/client/preparation.js';
import { startLocalTask } from '../../src/client/localTask.js';
import { preparationActivities } from '../../src/activities/preparation.js';
import { parsePreparation } from '../../src/policy/preparation.js';
import { digest } from '../../src/adapters/artifacts/files.js';
import { declareBackendFixture } from '../backendPolicyFixture.js';
import { controlTaskExecution, makeTaskExecutionCommand } from '../../src/client/taskExecution.js';
import type { PayloadReaderCommand } from '../../src/contracts/readerControl.js';
import { localTaskKey } from '../../src/policy/localTask.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = localTaskFixture();
  const input = parsePreparation(f.input.admission.preparation);
  const handle = { query: vi.fn(async () => input) };
  const start = vi.fn(async () => handle);
  const client = { workflow: { start } } as unknown as Client;
  const home = taskBackendHome(f.workspace);
  function policy(newTasks = 'temporal') {
    declareBackendFixture(f.workspace);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'backend-policy.json'),
      JSON.stringify({ schemaVersion: 1, newTasks }),
    );
  }
  function assign(backend: 'legacy' | 'temporal') {
    return reserveTaskBackend(f.workspace, {
      schemaVersion: 1,
      projectId: input.project.projectId,
      taskId: input.taskId,
      backend,
      cardName: 'one.md',
      origin: digest(readFileSync(join(f.workspace, input.card))),
    });
  }
  return { ...f, taskInput: f.input, input, client, start, handle, home, policy, assign };
}
describe('SDK and Worker task backend gates', () => {
  it('rejects rehashed control commands for another host, owner or generation before acquiring an RPC handle', async () => {
    const f = fixture();
    f.policy();
    f.assign('temporal');
    const target = { ...f.command().target, roleId: 'task', workflowId: localTaskKey(f.taskInput) };
    const executeUpdate = vi.fn(
      async (_name: string, options: { args: [PayloadReaderCommand] }) => {
        const command = options.args[0];
        return {
          commandId: command.commandId,
          hash: command.hash,
          revision: command.expectedRevision + 1,
          authorization: f.proof,
        };
      },
    );
    const getHandle = vi.fn(() => ({ executeUpdate }));
    const client = { workflow: { getHandle } } as unknown as Client;
    bindTaskBackendClient(client, f.registration);
    for (const changed of [
      { hostId: 'foreign-host' },
      { owner: 'foreign-owner' },
      { generation: target.generation + 1 },
    ]) {
      const command = makeTaskExecutionCommand({
        ...f.command(),
        schemaVersion: 2,
        target: { ...target, ...changed },
        payload: f.proof,
      });
      await expect(controlTaskExecution(client, target.workflowId, command)).rejects.toThrow(
        'backend-client-identity',
      );
    }
    expect(getHandle).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
    const command = makeTaskExecutionCommand({
      ...f.command(),
      schemaVersion: 2,
      target,
      payload: f.proof,
    });
    expect(await controlTaskExecution(client, target.workflowId, command)).toMatchObject({
      commandId: command.commandId,
      hash: command.hash,
    });
    expect(getHandle).toHaveBeenCalledOnce();
    expect(executeUpdate).toHaveBeenCalledWith('taskExecutionControl', { args: [command] });
  });
  it('preserves the original unconfigured SDK path without allocating backend metadata', async () => {
    const f = fixture();
    expect(() => requireClientTaskBackend(f.client, f.input)).toThrow('backend-client-unbound');
    bindTaskBackendClient(f.client, f.registration);
    expect(await startPreparation(f.client, f.input, 'queue')).toBe(f.handle);
    expect(f.start).toHaveBeenCalledOnce();
  });
  it('requires binding an SDK client when its process belongs to an enabled project', async () => {
    const f = fixture();
    f.policy();
    await expect(startPreparation(f.client, f.input, 'queue')).rejects.toThrow(
      'backend-client-unbound',
    );
    expect(f.start).not.toHaveBeenCalled();
  });
  it('binds once, freezes identity and refuses another registration', () => {
    const f = fixture();
    expect(bindTaskBackendClient(f.client, f.registration)).toBe(f.client);
    expect(bindTaskBackendClient(f.client, f.registration)).toBe(f.client);
    expect(bindTaskBackendClient(f.client, { ...f.registration })).toBe(f.client);
    expect(() =>
      bindTaskBackendClient(f.client, { ...f.registration, owner: 'replacement' }),
    ).toThrow('backend-client-already-bound');
    f.registration.owner = 'replacement';
    expect(() => requireClientTaskBackend(f.client, f.input)).not.toThrow();
    expect(() =>
      requireClientTaskBackend(f.client, {
        projectId: 'foreign',
        workspaceId: f.input.project.workspaceId,
        hostId: f.input.hostId,
        owner: f.input.owner,
        generation: f.input.generation,
        taskId: f.input.taskId,
      }),
    ).toThrow('backend-client-project');
  });
  it('routes known Temporal starts and controls but refuses unregistered and Legacy tasks before RPC', async () => {
    const f = fixture();
    f.policy();
    bindTaskBackendClient(f.client, f.registration);
    await expect(startLocalTask(f.client, f.taskInput, 'queue')).rejects.toThrow(
      'backend-assignment-required',
    );
    await expect(startPreparation(f.client, f.input, 'queue')).rejects.toThrow(
      'backend-assignment-required',
    );
    expect(f.start).not.toHaveBeenCalled();
    f.assign('temporal');
    expect(await startPreparation(f.client, f.input, 'queue')).toBe(f.handle);
    expect(() =>
      requireClientTaskBackend(f.client, {
        projectId: f.input.project.projectId,
        workspaceId: f.input.project.workspaceId,
        hostId: f.input.hostId,
        owner: f.input.owner,
        generation: f.input.generation,
        taskId: f.input.taskId,
      }),
    ).not.toThrow();
    const other = fixture();
    other.assign('legacy');
    other.policy();
    bindTaskBackendClient(other.client, other.registration);
    await expect(startPreparation(other.client, other.input, 'queue')).rejects.toThrow(
      'backend-route-conflict',
    );
    expect(other.start).not.toHaveBeenCalled();
  });
  it('reserves a new route once from exact card bytes without granting execution rights', () => {
    const f = fixture();
    expect(() => reserveNewTaskBackend(f.client, f.input)).toThrow('backend-client-unbound');
    bindTaskBackendClient(f.client, f.registration);
    expect(() => reserveNewTaskBackend(f.client, f.input)).toThrow('backend-policy-required');
    f.policy();
    const row = reserveNewTaskBackend(f.client, f.input);
    expect(row.backend).toBe('temporal');
    expect(row.origin).toBe(digest(readFileSync(join(f.workspace, f.input.card))));
    expect(reserveNewTaskBackend(f.client, f.input)).toEqual(row);
    f.policy('blocked');
    expect(() => reserveNewTaskBackend(f.client, { ...f.input, taskId: 'new-task' })).toThrow(
      'backend-new-tasks-blocked',
    );
    expect(() => requireClientTaskBackend(f.client, f.input)).not.toThrow();
  });
  it('checks the registered Worker before publishing preparation even after a raw Workflow start', async () => {
    const f = fixture();
    f.policy();
    const activities = preparationActivities(f.registration);
    await expect(activities.prepareProject(f.input)).rejects.toThrow('backend-assignment-required');
    f.assign('temporal');
    expect((await activities.prepareProject(f.input)).status).toBe('prepared');
    const legacy = fixture();
    legacy.assign('legacy');
    legacy.policy();
    await expect(
      preparationActivities(legacy.registration).prepareProject(legacy.input),
    ).rejects.toThrow('backend-route-conflict');
  });
  it('binds multiple projects to one SDK client without sharing their workspace authority', () => {
    const first = fixture(),
      second = fixture();
    const project = { ...second.input.project, projectId: 'second-project' };
    const registration = { ...second.registration, project };
    bindTaskBackendClient(first.client, first.registration);
    bindTaskBackendClient(first.client, registration);
    expect(() => requireClientTaskBackend(first.client, first.input)).not.toThrow();
    expect(() =>
      requireClientTaskBackend(first.client, { ...second.input, project }),
    ).not.toThrow();
    expect(() => bindTaskBackendClient(first.client, { ...registration, generation: 0 })).toThrow(
      'backend-generation-invalid',
    );
    expect(() =>
      bindTaskBackendClient(first.client, { ...registration, taskBackend: 'other' as never }),
    ).toThrow('backend-mode-invalid');
  });
  it('refuses SDK and raw Activity effects after registered Git metadata is lost', async () => {
    const f = fixture();
    bindTaskBackendClient(f.client, f.registration);
    const activities = preparationActivities(f.registration);
    f.assign('legacy');
    f.policy();
    const git = join(f.workspace, '.git');
    renameSync(git, git + '-retained');
    try {
      await expect(startPreparation(f.client, f.input, 'queue')).rejects.toThrow();
      await expect(activities.prepareProject(f.input)).rejects.toThrow();
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      renameSync(git + '-retained', git);
    }
  });
  it('refuses a replacement workspace even when its absolute path stays the same', () => {
    const f = fixture();
    bindTaskBackendClient(f.client, f.registration);
    renameSync(f.workspace, f.workspace + '-retained');
    mkdirSync(f.workspace);
    try {
      expect(() => requireClientTaskBackend(f.client, f.input)).toThrow(
        'backend-workspace-changed',
      );
    } finally {
      rmSync(f.workspace, { recursive: true });
      renameSync(f.workspace + '-retained', f.workspace);
    }
  });
  it('honors a required deployment configuration across a restart without declarations', async () => {
    const f = fixture();
    bindTaskBackendClient(f.client, { ...f.registration, taskBackend: 'required' });
    await expect(startPreparation(f.client, f.input, 'queue')).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  });
});
