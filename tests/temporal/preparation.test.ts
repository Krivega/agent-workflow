import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { NativeConnection } from '@temporalio/worker';
import type { PreparationInput } from '../../src/contracts/preparation.js';
import { preparationActivities } from '../../src/activities/preparation.js';
import { artifactStore } from '../../src/adapters/artifacts/files.js';
import { startPreparation } from '../../src/client/preparation.js';
import { bindTaskBackendClient } from '../../src/client/taskBackend.js';
import { createPreparationWorker } from '../../src/worker/host.js';
import { PreparationWorkflow } from '../../src/workflows/preparation.js';
import { captureRegistration } from '../../src/adapters/project/preparation.js';

const sdk = vi.hoisted(() => ({
  prepareProject: vi.fn(),
  setHandler: vi.fn(),
  createWorker: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({
  defineQuery: (name: string) => name,
  proxyActivities: () => ({ prepareProject: sdk.prepareProject }),
  setHandler: sdk.setHandler,
}));
vi.mock('@temporalio/worker', () => ({ Worker: { create: sdk.createWorker } }));

const roots: string[] = [];
const project = {
  schemaVersion: 1 as const,
  projectId: 'neutral',
  workspaceId: 'main',
  rules: ['RULES.md'],
  cardRoot: 'tasks',
  roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
  checks: ['syntax'],
};
const input: PreparationInput = {
  schemaVersion: 1,
  taskId: 'one',
  project,
  hostId: 'mac',
  owner: 'user',
  generation: 1,
  revision: 1,
  card: 'tasks/one.md',
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-prepare-')));
  roots.push(root);
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/one.md'), 'Task');
  writeFileSync(join(root, 'RULES.md'), 'Rules');
  writeFileSync(join(root, 'reviewer.md'), 'Profile');
  return {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: root,
    artifactRoot: join(root, 'artifacts'),
    commands: { syntax: { executable: 'node', args: ['--check', 'main.js'] } },
  };
}
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project preparation Activity', () => {
  it('captures project, command objects and argument arrays without changing scalar paths', async () => {
    const registration = { ...fixture(), project: structuredClone(project) };
    const captured = captureRegistration(registration);
    const activities = preparationActivities(registration);
    registration.commands.syntax.executable = '';
    registration.commands.syntax.args.push('changed');
    registration.project.rules.push('not-registered');
    expect(captured.workspaceRoot).toBe(registration.workspaceRoot);
    expect(captured.commands.syntax!.args).toEqual(['--check', 'main.js']);
    expect((await activities.prepareProject(input)).status).toBe('prepared');
    expect(() => captureRegistration({ ...registration, taskBackend: 'other' as never })).toThrow(
      'backend-registration-invalid',
    );
  });
  it('binds exact bytes without starting checks or any model', async () => {
    const registration = fixture();
    const activities = preparationActivities(registration);
    const result = await activities.prepareProject(input);
    expect(await activities.prepareProject(input)).toEqual(result);
    expect(result.status).toBe('prepared');
    const manifest = JSON.parse(
      artifactStore(registration.artifactRoot).read(result.manifest).toString(),
    ) as { input: PreparationInput; inputs: { path: string; sha256: string }[] };
    expect(manifest.input).toEqual(input);
    expect(manifest.inputs.map((ref) => ref.path)).toEqual([
      'RULES.md',
      'reviewer.md',
      'tasks/one.md',
    ]);
    writeFileSync(join(registration.workspaceRoot, 'RULES.md'), 'Changed');
    const changed = await activities.prepareProject(input);
    expect(changed.manifest).not.toEqual(result.manifest);
    expect(artifactStore(registration.artifactRoot).read(result.manifest).toString()).toContain(
      'preparation',
    );
  });
  it('fails before publishing when any required input is absent', async () => {
    const registration = fixture();
    rmSync(join(registration.workspaceRoot, 'reviewer.md'));
    await expect(preparationActivities(registration).prepareProject(input)).rejects.toThrow(
      'ENOENT',
    );
    expect(readdirSync(registration.artifactRoot)).toEqual([]);
  });
  it('rejects commands outside the trusted local registry', async () => {
    const registration = fixture();
    await expect(
      preparationActivities({ ...registration, commands: {} }).prepareProject(input),
    ).rejects.toThrow('unregistered-check');
    for (const command of [
      { executable: '', args: [] },
      { executable: 'node', args: null },
    ]) {
      await expect(
        preparationActivities({
          ...registration,
          commands: { syntax: command },
        } as unknown as typeof registration).prepareProject(input),
      ).rejects.toThrow('invalid-registered-command');
    }
  });
  it('prepares the real game descriptor through the same contract', () => {
    const descriptor = JSON.parse(
      readFileSync(new URL('../../project/temporal.json', import.meta.url), 'utf8'),
    ) as unknown;
    const registration = fixture();
    expect(() => preparationActivities({ ...registration, project: descriptor })).not.toThrow();
  });
});

describe('Temporal preparation boundary', () => {
  it('delegates only external preparation and exposes the accepted input', async () => {
    const result = { status: 'prepared', manifest: { sha256: 'a'.repeat(64), bytes: 1 } };
    sdk.prepareProject.mockResolvedValue(result);
    expect(await PreparationWorkflow(input)).toEqual(result);
    const handler = sdk.setHandler.mock.calls[0]![1] as () => PreparationInput;
    expect(handler()).toEqual(input);
    expect(sdk.prepareProject).toHaveBeenCalledWith(input);
  });
  it('starts with explicit ID policies and checks reuse against the accepted input', async () => {
    const query = vi.fn().mockResolvedValue(input);
    const handle = { query };
    const start = vi.fn().mockResolvedValue(handle);
    const client = { workflow: { start } } as unknown as Client;
    bindTaskBackendClient(client, fixture());
    expect(await startPreparation(client, input, 'local')).toBe(handle);
    expect(start.mock.calls[0]![1]).toMatchObject({
      workflowId: 'aw/preparation/neutral/one',
      taskQueue: 'local',
    });
    query.mockResolvedValue({ ...input, revision: 2 });
    await expect(startPreparation(client, input, 'local')).rejects.toThrow(
      'preparation-start-conflict',
    );
  });
  it('registers only the local project with a bounded preparation Worker', async () => {
    const registration = fixture();
    sdk.createWorker.mockResolvedValue('worker');
    expect(
      await createPreparationWorker(
        {} as NativeConnection,
        'local',
        '/build/workflows.js',
        registration,
      ),
    ).toBe('worker');
    expect(sdk.createWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        taskQueue: 'local',
        workflowsPath: '/build/workflows.js',
        maxConcurrentActivityTaskExecutions: 1,
      }),
    );
  });
});
