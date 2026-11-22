import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { declareBackendFixture } from './backendPolicyFixture.js';
import { readdir } from 'node:fs/promises';
import { reserveTaskBackend } from '../src/adapters/project/taskBackend.js';
import { dirname, resolve } from 'node:path';
import { NativeUserCommands, userCommandNotice } from '../adapters/codex/userCommands.js';
import { localFixture } from './localFixtures.js';
import { contentHash } from '../adapters/project/projectFiles.js';
import { object } from '../core/connection.js';
import { stableJson } from '../core/equality.js';
import type { InputRef } from '../core/localRun.js';
import { runChatCommand } from '../cli/chatCommand.js';
import * as privateFiles from '../adapters/storage/storeFiles.js';
import type * as NodeOs from 'node:os';
const fakeHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => fakeHome.path,
}));
let f: Awaited<ReturnType<typeof localFixture>>;
let external: string;
let records: Record<string, unknown>[];
let transcript: string;
let commands: NativeUserCommands;
let request: Record<string, unknown>;
const target = {
  project_id: 'project',
  task_id: 'task',
  run_id: 'run',
  thread_id: 'receiver',
  generation: 1,
  control_revision: 0,
  requirements_revision: 0,
};
it('requires the existing Legacy assignment before issuing a native user command', async () => {
  execFileSync('git', ['init', '-q'], { cwd: f.root });
  declareBackendFixture(f.root);
  await f.file(
    '.git/agent-workflow/backend-policy.json',
    JSON.stringify({ schemaVersion: 1, newTasks: 'temporal' }),
  );
  const before = await readdir(external);
  await expect(commands.issue(request)).rejects.toThrow('backend-assignment-required');
  expect(await readdir(external)).toEqual(before);
  reserveTaskBackend(f.root, {
    schemaVersion: 1,
    projectId: 'project',
    taskId: 'task',
    backend: 'legacy',
    cardName: 'task.md',
    origin: 'a'.repeat(64),
  });
  expect(typeof (await commands.issue(request)).user_command).toBe('string');
});
async function save() {
  await writeFile(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
beforeEach(async () => {
  f = await localFixture();
  external = await mkdtemp(resolve(dirname(f.root), 'user-command-'));
  fakeHome.path = external;
  await mkdir(resolve(external, 'sessions/2026/10/17'), { recursive: true });
  transcript = resolve(external, 'sessions/2026/10/17/issuer.jsonl');
  records = [
    {
      type: 'session_meta',
      payload: {
        id: 'issuer',
        session_id: 'issuer',
        cwd: f.root,
        cli_version: '0.163.0-alpha.10.2',
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Продолжи задачу в прежнем чате' }],
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: f.root,
        model: 'fixture-model',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  ];
  await save();
  vi.stubEnv('CODEX_HOME', external);
  vi.stubEnv('CODEX_THREAD_ID', 'issuer');
  request = {
    transcript,
    anchor: { thread_id: 'issuer', turn_id: 'turn', workspace: f.root, host_id: 'local' },
    human_source: {
      locator: transcript + '#L3',
      hash: contentHash(JSON.stringify(records[2]) + '\n'),
    },
    target,
    command_root: external,
  };
  commands = new NativeUserCommands(f.root);
});
afterEach(async () => {
  await f.dispose();
  await rm(external, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function issued() {
  const notice = await commands.issue(request);
  records.push({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'issuer',
      turn_id: 'turn',
      item: {
        type: 'CommandExecution',
        cwd: f.root,
        status: 'completed',
        exit_code: 0,
        aggregated_output: JSON.stringify(notice),
      },
    },
  });
  await save();
  return notice.authorization;
}
async function altered(ref: InputRef, edit: (value: Record<string, unknown>) => void) {
  const value = object(JSON.parse(await readFile(ref.locator, 'utf8')) as unknown);
  edit(value);
  const bytes = stableJson(value) + '\n';
  const changed = { locator: ref.locator, hash: contentHash(bytes) };
  await writeFile(ref.locator, bytes);
  object(object(records[4]!.payload).item).aggregated_output = JSON.stringify(
    userCommandNotice(changed),
  );
  await save();
  return changed;
}

async function registeredIssuerWorktree() {
  const origin = resolve(f.root, 'issuer-origin'),
    gitdir = resolve(origin, '.git/worktrees/receiver');
  await mkdir(origin);
  execFileSync('git', ['init', '--quiet'], { cwd: origin });
  await mkdir(gitdir, { recursive: true });
  await writeFile(resolve(f.root, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(resolve(gitdir, 'commondir'), '../..\n');
  await writeFile(resolve(gitdir, 'gitdir'), resolve(f.root, '.git') + '\n');
  await writeFile(resolve(gitdir, 'HEAD'), await readFile(resolve(origin, '.git/HEAD')));
  expect(
    execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: f.root,
      encoding: 'utf8',
    }).trim(),
  ).toBe(resolve(origin, '.git'));
  Object.assign(object(records[0]!.payload), {
    cwd: origin,
    cli_version: '0.165.0-alpha.1.2',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  });
  await save();
}

it('verifies the original worktree command turn after a later issuer turn without changing the target', async () => {
  await registeredIssuerWorktree();
  const ref = await issued();
  records.push(
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } },
    {
      type: 'turn_context',
      payload: { ...object(records[3]!.payload), turn_id: 'later', cwd: external },
    },
  );
  await save();
  vi.stubEnv('CODEX_THREAD_ID', 'receiver');
  await expect(commands.verify(ref, target)).resolves.toBeUndefined();
  await expect(commands.verify(ref, { ...target, generation: 2 })).rejects.toThrow(
    'chat-command-target-mismatch',
  );
});

it('does not treat Git registration as primary native command issuance', async () => {
  await registeredIssuerWorktree();
  const notice = await commands.issue(request);
  await expect(commands.verify(notice.authorization, target)).rejects.toThrow(
    'chat-command-issuance-unconfirmed',
  );
});

it('verifies a .166 primary command only for its original same-root native turn', async () => {
  Object.assign(object(records[0]!.payload), {
    cli_version: '0.166.0-alpha.6',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  });
  await save();
  const ref = await issued();
  records.push({ type: 'turn_context', payload: { turn_id: 'later', cwd: external } });
  await save();
  await expect(commands.verify(ref, target)).resolves.toBeUndefined();
  records.push({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      namespace: 'codex_app',
      name: 'send_message_to_thread',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn' },
    },
  });
  await save();
  await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-human-delegated');
  records.pop();
  object(records[3]!.payload).cwd = external;
  await save();
  await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-issuer-unconfirmed');
});

it.each(['missing', 'foreign-turn', 'duplicate', 'foreign-workspace', 'later-substitution'])(
  'refuses a worktree authorization without its exact primary command context: %s',
  async (kind) => {
    await registeredIssuerWorktree();
    const ref = await issued();
    if (kind === 'missing' || kind === 'later-substitution') records.splice(3, 1);
    if (kind === 'foreign-turn') object(records[3]!.payload).turn_id = 'foreign';
    if (kind === 'duplicate') records.push(structuredClone(records[3]!));
    if (kind === 'foreign-workspace') object(records[3]!.payload).cwd = external;
    if (kind === 'later-substitution')
      records.push({ type: 'turn_context', payload: { turn_id: 'later', cwd: f.root } });
    await save();
    await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-issuer-unconfirmed');
  },
);
it.each([
  '0.162.0-alpha.17.2',
  '0.163.0-alpha.10.2',
  '0.163.0-alpha.11',
  '0.163.0-alpha.11.1',
  '0.163.0-alpha.11.2',
  '0.164.0-alpha.11.1',
])(
  'verifies native human authorization from %s after delivery and later issuer turns without resuming either chat',
  async (clientVersion) => {
    object(records[0]!.payload).cli_version = clientVersion;
    await save();
    const ref = await issued();
    expect(await commands.issue(request)).toEqual(userCommandNotice(ref));
    records.push(
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } },
    );
    await save();
    vi.stubEnv('CODEX_THREAD_ID', 'receiver');
    await expect(commands.verify(ref, target)).resolves.toBeUndefined();
    await expect(commands.verify(ref, target)).resolves.toBeUndefined();
  },
);
it('requires a native issuance, not just a file with a human source', async () => {
  const notice = await commands.issue(request);
  await expect(commands.verify(notice.authorization, target)).rejects.toThrow(
    'chat-command-issuance-unconfirmed',
  );
});
it('retains a failed native issuance and accepts its successful idempotent retry', async () => {
  const ref = await issued();
  const successful = structuredClone(records[4]!);
  object(object(records[4]!.payload).item).exit_code = 1;
  records.push(successful);
  await save();
  await expect(commands.verify(ref, target)).resolves.toBeUndefined();
});
it('issues the unchanged native notice through the CLI and validates its flags', async () => {
  const path = resolve(external, 'request.json');
  await writeFile(path, JSON.stringify({ schema_version: 1, root: f.root, ...request }));
  const output: string[] = [];
  expect(
    await runChatCommand(
      ['authorize-chat', path, '--brief'],
      (line) => output.push(line),
      () => {},
    ),
  ).toBe(0);
  expect(JSON.parse(output[0]!)).toHaveProperty('authorization');
  expect(
    await runChatCommand(
      ['authorize-chat', path, '--invalid'],
      () => {},
      () => {},
    ),
  ).toBe(2);
  expect(
    await runChatCommand(
      ['authorize-chat', path, '--full', 'extra'],
      () => {},
      () => {},
    ),
  ).toBe(2);
});
it('rejects a nonexistent private output directory without treating it as an idempotent retry', async () => {
  await expect(
    commands.issue({ ...request, command_root: resolve(external, 'missing') }),
  ).rejects.toThrow('ENOENT');
});
it('uses the native default home when CODEX_HOME is absent and propagates storage failures', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  await expect(commands.issue(request)).rejects.toThrow('ENOENT');
  vi.stubEnv('CODEX_HOME', external);
  vi.spyOn(privateFiles, 'writePrivateFile').mockImplementationOnce(() => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  await expect(commands.issue(request)).rejects.toThrow('disk full');
});
it.each(['project_id', 'task_id', 'run_id', 'thread_id'] as const)(
  'rejects a different target %s',
  async (field) => {
    const ref = await issued();
    await expect(commands.verify(ref, { ...target, [field]: 'other' })).rejects.toThrow(
      'chat-command-target-mismatch',
    );
  },
);
it.each(['generation', 'control_revision', 'requirements_revision'] as const)(
  'binds the delivered command to %s',
  async (field) => {
    const ref = await issued();
    await expect(commands.verify(ref, { ...target, [field]: target[field] + 1 })).rejects.toThrow(
      'chat-command-target-mismatch',
    );
    await expect(
      commands.issue({ ...request, target: { ...target, [field]: -1 } }),
    ).rejects.toThrow('chat-command-revision-required');
    await expect(
      commands.issue({ ...request, target: { ...target, [field]: 1.5 } }),
    ).rejects.toThrow('chat-command-revision-required');
  },
);
it.each(['schema_version', 'action'])('rejects an unsupported command %s', async (field) => {
  const ref = await issued();
  const changed = await altered(ref, (value) => {
    value[field] = field === 'schema_version' ? 2 : 'CANCEL';
  });
  await expect(commands.verify(changed, target)).rejects.toThrow('chat-command-target-mismatch');
});
it('rejects changed receipt bytes and conflicting immutable files', async () => {
  const ref = await issued();
  await writeFile(ref.locator, '{}');
  await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-changed');
  await expect(commands.issue(request)).rejects.toThrow('chat-command-conflict');
});
it.each(['service', 'empty', 'missing-content', 'wrong-kind', 'wrong-message', 'wrong-turn'])(
  'rejects a nonhuman source: %s',
  async (kind) => {
    const ref = await issued();
    const payload = object(records[2]!.payload);
    switch (kind) {
      case 'service':
        payload.role = 'developer';
        break;
      case 'empty':
        payload.content = [{ type: 'input_text', text: '' }];
        break;
      case 'missing-content':
        payload.content = null;
        break;
      case 'wrong-kind':
        payload.content = [{ type: 'text', text: 'message' }];
        break;
      case 'wrong-message':
        payload.type = 'function_call';
        break;
      case 'wrong-turn':
        object(records[1]!.payload).turn_id = 'other';
        break;
    }
    await save();
    const changed = await altered(ref, (value) => {
      object(object(value.issuer).source).hash = contentHash(JSON.stringify(records[2]) + '\n');
    });
    await expect(commands.verify(changed, target)).rejects.toThrow(
      'chat-command-human-unconfirmed',
    );
  },
);
it.each([
  'source-missing',
  'no-output',
  'wrong-item',
  'wrong-thread',
  'wrong-turn',
  'wrong-cwd',
  'failed',
  'exit-code',
  'before-human',
])('requires the exact successful native issuance: %s', async (kind) => {
  let ref = await issued();
  const payload = object(records[4]!.payload),
    item = object(payload.item);
  switch (kind) {
    case 'source-missing':
      ref = await altered(ref, (value) => {
        object(object(value.issuer).source).hash = 'b'.repeat(64);
      });
      break;
    case 'no-output':
      item.aggregated_output = '';
      break;
    case 'wrong-item':
      item.type = 'McpToolCall';
      break;
    case 'wrong-thread':
      payload.thread_id = 'other';
      break;
    case 'wrong-turn':
      payload.turn_id = 'other';
      break;
    case 'wrong-cwd':
      item.cwd = external;
      break;
    case 'failed':
      item.status = 'failed';
      break;
    case 'exit-code':
      item.exit_code = 1;
      break;
    case 'before-human':
      records.splice(2, 0, records.pop()!);
      break;
  }
  await save();
  await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-issuance-unconfirmed');
});
it.each(['id', 'session_id', 'cwd', 'cli_version', 'duplicate', 'workspace', 'host'])(
  'requires a confirmed native issuer: %s',
  async (kind) => {
    let ref = await issued();
    const session = object(records[0]!.payload);
    if (kind === 'duplicate') records.push(records[0]!);
    else if (kind === 'workspace' || kind === 'host')
      ref = await altered(ref, (value) => {
        object(object(value.issuer).anchor)[kind === 'workspace' ? 'workspace' : 'host_id'] =
          kind === 'workspace' ? external : 'remote';
      });
    else session[kind] = kind === 'cwd' ? external : 'other';
    await save();
    await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-issuer-unconfirmed');
  },
);
it('rejects copied, symlinked, partial and wrong-environment issuance sources', async () => {
  const ref = await issued();
  const copy = resolve(external, 'copy.jsonl');
  await writeFile(copy, await readFile(transcript));
  await expect(commands.issue({ ...request, transcript: copy })).rejects.toThrow(
    'chat-command-native-source-required',
  );
  const link = resolve(dirname(transcript), 'link.jsonl');
  await symlink(transcript, link);
  await expect(commands.issue({ ...request, transcript: link })).rejects.toThrow(
    'chat-command-native-source-required',
  );
  vi.stubEnv('CODEX_THREAD_ID', 'other');
  await expect(commands.issue(request)).rejects.toThrow('chat-environment-identity-mismatch');
  vi.stubEnv('CODEX_THREAD_ID', 'issuer');
  await expect(commands.issue({ ...request, command_root: f.root })).rejects.toThrow(
    'chat-command-must-be-external',
  );
  await expect(
    commands.issue({ ...request, command_root: resolve(f.root, 'inner') }),
  ).rejects.toThrow('chat-command-must-be-external');
  await writeFile(transcript, (await readFile(transcript, 'utf8')).trimEnd());
  await expect(commands.verify(ref, target)).rejects.toThrow('chat-command-history-partial');
});
