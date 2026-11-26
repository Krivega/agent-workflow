import { readerExecution } from '../../src/policy/readerExecution.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { ReaderInput } from '../../src/contracts/reader.js';
import { artifactStore } from '../../src/adapters/artifacts/files.js';
import { readerBoundary } from '../../src/adapters/codex/readerBoundary.js';
import { readerControlActivities } from '../../src/activities/readerControl.js';
import { makeReaderCommand } from '../../src/client/reader.js';
import { readerKey, readerTarget } from '../../src/policy/readerControl.js';

const roots: string[] = [];
let firstTestRoot = 0;
function disposeFrom(first: number) {
  for (const root of roots.splice(first)) rmSync(root, { recursive: true, force: true });
}
beforeEach(() => {
  firstTestRoot = roots.length;
});
afterEach(() => disposeFrom(firstTestRoot));
afterAll(() => disposeFrom(0));
export function controlFixture(clientVersion = '0.154.0') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aw-control-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'tasks'), { recursive: true });
  for (const path of ['RULES.md', 'reviewer.md', 'tasks/one.md'])
    writeFileSync(join(workspace, path), path);
  const project = {
    schemaVersion: 1 as const,
    projectId: 'neutral',
    workspaceId: 'main',
    rules: ['RULES.md'],
    cardRoot: 'tasks',
    roles: [{ id: 'reviewer', profile: 'reviewer.md' }],
    checks: ['syntax'],
  };
  const input: ReaderInput = {
    preparation: {
      schemaVersion: 1,
      project,
      taskId: 'one',
      hostId: 'mac',
      owner: 'user',
      generation: 1,
      revision: 1,
      card: 'tasks/one.md',
    },
    roleId: 'reviewer',
  };
  const registration = {
    project,
    hostId: 'mac',
    owner: 'user',
    generation: 1,
    workspaceRoot: workspace,
    artifactRoot: join(root, 'artifacts'),
    commands: { syntax: { executable: 'node', args: [] } },
  };
  const profile = { model: 'gpt-6-astra', effort: 'medium', clientVersion };
  const store = artifactStore(registration.artifactRoot);
  const save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  const proof = save({ kind: 'test-authority' });
  const response = {
    cwd: workspace,
    model: profile.model,
    reasoningEffort: 'medium',
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: {
      id: 'session',
      cwd: workspace,
      projectId: null,
      parentThreadId: null,
      forkedFromId: null,
      turns: [] as Record<string, unknown>[],
    },
  };
  const rpc = {
    request: vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/read') return structuredClone({ thread: response.thread });
      if (method === 'turn/interrupt') {
        response.thread.turns.find((turn) => turn.id === params.turnId)!.status = 'interrupted';
        return {};
      }
      throw new Error('unexpected-rpc:' + method);
    }),
    completed: vi.fn(async () => {}),
  };
  const authority = {
    verify: vi.fn(async (c: ReturnType<typeof makeReaderCommand>) => ({
      origin: 'human' as 'human' | 'initial-grant',
      author: c.author,
      hash: c.hash,
      proof,
    })),
  };
  const boundaryRoot = join(root, 'permissions');
  const gate = readerBoundary(boundaryRoot, store, workspace, readerExecution(profile));
  const controls = readerControlActivities(registration, rpc, gate, authority);
  const permit = gate.install(input);
  const epoch = { permit, revision: 0, attempt: 0 };
  const command = (
    action: 'pause' | 'resume' | 'cancel' = 'pause',
    revision = 0,
    attempt = 0,
    id: string = action,
  ) =>
    makeReaderCommand({
      schemaVersion: 1,
      commandId: id,
      target: readerTarget(input, readerKey(input)),
      expectedRevision: revision,
      author: 'user',
      action,
      attempt,
      source: proof,
    });
  return {
    root,
    workspace,
    input,
    registration,
    profile,
    store,
    save,
    proof,
    response,
    rpc,
    authority,
    boundaryRoot,
    gate,
    controls,
    permit,
    epoch,
    command,
  };
}
