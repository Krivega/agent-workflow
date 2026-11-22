import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { runChatCommand } from '../cli/chatCommand.js';
import { localFixture } from './localFixtures.js';
import { saveCouncilProgress } from '../cli/councilProgress.js';
import { workflowFixture } from './workflowFixtures.js';
import { readArtifactFile } from '../adapters/storage/sharedArtifacts.js';
let f: Awaited<ReturnType<typeof localFixture>>;
let external: string;
beforeEach(async () => {
  f = await localFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'chat-command-'));
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function invoke(command: string, request: unknown) {
  await f.file('request.json', JSON.stringify(request));
  const output: string[] = [],
    errors: string[] = [];
  const code = await runChatCommand(
    [command, resolve(f.root, 'request.json')],
    (s) => output.push(s),
    (s) => errors.push(s),
  );
  return { code, output, errors };
}
it.each([
  'freeze-checks',
  'package-checks',
  'refresh-council',
  'repeat-council',
  'retain-store',
  'relocate-files',
  'materialize-files',
])(
  'refuses unqualified %s before evidence or Store writes on an activated project',
  async (command) => {
    execFileSync('git', ['init', '-q'], { cwd: f.root });
    declareBackendFixture(f.root);
    await f.file(
      '.git/agent-workflow/backend-policy.json',
      JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
    );
    const before = await readdir(external);
    const result = await invoke(command, {
      schema_version: 1,
      root: f.root,
      evidence_root: external,
    });
    expect(result.errors).toEqual(['backend-consumer-not-qualified']);
    expect(result.code).toBe(1);
    expect(await readdir(external)).toEqual(before);
  },
);
it('rejects unsupported commands/arguments and unknown request versions before effects', async () => {
  for (const args of [
    [],
    ['other', 'file'],
    ['read-chat'],
    ['read-chat', ''],
    ['read-chat', 'a', 'b'],
  ]) {
    const error = vi.fn();
    expect(await runChatCommand(args, vi.fn(), error)).toBe(2);
    expect(error).toHaveBeenCalledOnce();
  }
  expect((await invoke('read-chat', { schema_version: 2 })).errors).toEqual([
    'unsupported-chat-request',
  ]);
  const error = vi.fn();
  expect(await runChatCommand(['read-chat', '/nonexistent'], vi.fn(), error)).toBe(1);
});
it('waits on compact council progress without native chat access or writer acquisition', async () => {
  const directory = resolve(external, 'council');
  await mkdir(directory);
  const snapshot = saveCouncilProgress(directory, {
    schema_version: 1,
    run_id: 'run',
    phase: 'planning',
    scope: 'scope',
    target_hash: 'hash',
    status: 'completed',
    roles: {},
  });
  const request = { schema_version: 1, root: f.root, evidence_root: external };
  const first = await invoke('wait-council', request);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.output[0]!)).toMatchObject({ changed: true, snapshot });
  const second = await invoke('wait-council', {
    ...request,
    after: snapshot.cursor,
    timeout_ms: 0,
  });
  expect(JSON.parse(second.output[0]!)).toMatchObject({ changed: false, snapshot });
});
it('refreshes a council into a referenced artifact without changing its source state', async () => {
  const workflow = await workflowFixture();
  try {
    const council = workflow.council('acceptance');
    const result = await invoke('refresh-council', {
      schema_version: 1,
      root: workflow.root,
      evidence_root: external,
      council,
      target: workflow.target,
    });
    expect(result.code).toBe(0);
    const reply = JSON.parse(result.output[0]!) as {
      details: { locator: string };
      blockers: string[];
    };
    expect(reply.blockers).toEqual([]);
    expect(readArtifactFile(reply.details.locator)).toMatchObject({
      phase: 'acceptance',
      target: workflow.target,
    });
    expect(council.advisers.architect!.status).toBe('answered');
  } finally {
    await workflow.dispose();
  }
});
it('emits exact full content with a marker for only declared read inputs', async () => {
  const request = {
    schema_version: 1,
    root: f.root,
    descriptor: 'connection.json',
    marker: 'probe',
    locators: ['AGENTS.md', f.spec.procedures[0]!.locator],
  };
  const reply = await invoke('read-chat', request);
  expect(reply.code).toBe(0);
  expect(reply.output.map((s) => JSON.parse(s) as unknown)).toEqual(
    [f.loaded.rules[0]!, f.loaded.procedures[0]!].map((entry) => ({
      chat_read: 'probe',
      locator: entry.locator,
      hash: entry.hash,
      content: entry.content,
    })),
  );
  expect((await invoke('read-chat', { ...request, locators: [] })).code).toBe(1);
  expect((await invoke('read-chat', { ...request, locators: ['source.txt'] })).errors).toEqual([
    'chat-read-outside-rules',
  ]);
});
it('connects one selected task and returns the real connection receipt', async () => {
  const reply = await invoke('connect-chat', {
    schema_version: 1,
    root: f.root,
    descriptor: 'connection.json',
    journal: resolve(external, 'journal'),
    cards: [f.card.locator],
    create: null,
  });
  expect(reply.code).toBe(0);
  expect(JSON.parse(reply.output[0]!)).toMatchObject({
    plan: { task_id: 'task' },
    receipt: { phase: 'enabled' },
  });
});
it('observes the actual native metadata and rejects a different environment identity', async () => {
  const records = [
    {
      type: 'session_meta',
      payload: {
        id: 'session',
        session_id: 'session',
        cli_version: '0.162.0-alpha.17.2',
        cwd: f.root,
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: f.root,
        model: 'fixture',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  ];
  await f.file('transcript.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const request = {
    schema_version: 1,
    root: f.root,
    transcript: resolve(f.root, 'transcript.jsonl'),
    anchor: { thread_id: 'session', turn_id: 'turn', workspace: f.root, host_id: 'local' },
  };
  vi.stubEnv('CODEX_THREAD_ID', 'session');
  const reply = await invoke('observe-chat', request);
  expect(reply.code).toBe(0);
  expect(JSON.parse(reply.output[0]!)).toMatchObject({ thread_id: 'session', model: 'fixture' });
  vi.stubEnv('CODEX_THREAD_ID', 'other');
  expect((await invoke('observe-chat', request)).errors).toEqual([
    'chat-environment-identity-mismatch',
  ]);
});
it('preserves unexpected failure diagnostics', async () => {
  const code = await runChatCommand(['read-chat', '/missing'], vi.fn(), (message) => {
    expect(message).toContain('ENOENT');
  });
  expect(code).toBe(1);
});

it('reports an output transport failure without declaring success', async () => {
  await f.file(
    'request.json',
    JSON.stringify({
      schema_version: 1,
      root: f.root,
      descriptor: 'connection.json',
      marker: 'read',
      locators: ['AGENTS.md'],
    }),
  );
  const errors: string[] = [];
  expect(
    await runChatCommand(
      ['read-chat', resolve(f.root, 'request.json')],
      () => {
        throw 'transport lost';
      },
      (s) => errors.push(s),
    ),
  ).toBe(1);
  expect(errors).toEqual(['Не удалось выполнить операцию чата.']);
});
