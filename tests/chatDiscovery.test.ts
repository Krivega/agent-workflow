import { mkdir, readFile, writeFile, mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import { readManaged, saveManaged } from '../adapters/storage/managedChatFiles.js';
import { taskChatOptions, taskChatGates, taskChatBrief } from '../cli/taskChatInputs.js';
import { taskChatContext } from '../cli/taskChatInputs.js';
import * as fs from 'node:fs';
const faults = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.rename) throw new Error('rename failed');
      return actual.renameSync(...args);
    },
  };
});
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'chat-discovery-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  faults.rename = false;
});

it('cleans a failed atomic replacement and retains the previous metadata', () => {
  const path = resolve(root, 'state.json');
  saveManaged(path, { revision: 1 });
  faults.rename = true;
  expect(() => saveManaged(path, { revision: 2 })).toThrow('rename failed');
  expect(readManaged(path)).toEqual({ revision: 1 });
  expect(fs.readdirSync(root)).toEqual(['state.json']);
});

it('uses the default Codex home but requires an explicit current native thread', async () => {
  vi.stubEnv('CODEX_HOME', undefined);
  vi.stubEnv('CODEX_THREAD_ID', undefined);
  await expect(taskChatContext(root)).rejects.toThrow();
});
function native() {
  return [
    {
      type: 'session_meta',
      payload: { id: 'thread', session_id: 'thread', cli_version: '0.163.0-alpha.10.2', cwd: root },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Поручение' }],
      },
    },
    {
      type: 'turn_context',
      payload: {
        turn_id: 'turn',
        cwd: root,
        model: 'model',
        effort: 'high',
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        permission_profile: { type: 'disabled' },
      },
    },
  ];
}
async function source(records: unknown[]) {
  await mkdir(resolve(root, 'sessions/year'), { recursive: true });
  const file = resolve(root, 'sessions/year/rollout-thread.jsonl');
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
it('discovers nested native history and ignores skill, page and nonhuman messages', async () => {
  const records: unknown[] = native();
  records.push(
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: null } },
  );
  for (const text of [' ', '<external_codex_apps_open_page>{}', '<skill>instructions'])
    records.push({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }, { type: 'image' }],
      },
    });
  const path = await source(records);
  await symlink(path, resolve(root, 'sessions/ignored-thread.jsonl'));
  const result = await discoverChat(root, resolve(root, 'sessions'), 'thread');
  expect(result.human_source.locator).toBe(path + '#L3');
  expect(result.anchor.turn_id).toBe('turn');
});
it('rejects absent, ambiguous, incomplete and nonhuman current sources', async () => {
  await expect(discoverChat(root, root, '../thread')).rejects.toThrow('invalid-chat-thread');
  await expect(discoverChat(root, root, 'thread')).rejects.toThrow('chat-transcript-not-unique');
  const path = await source(native());
  await writeFile(resolve(root, 'sessions/duplicate-thread.jsonl'), await readFile(path));
  await expect(discoverChat(root, root, 'thread')).rejects.toThrow('chat-transcript-not-unique');
  await rm(resolve(root, 'sessions/duplicate-thread.jsonl'));
  await source(native().filter((r) => r.type !== 'turn_context'));
  await expect(discoverChat(root, root, 'thread')).rejects.toThrow('chat-context-missing');
  await source(native().filter((r) => r.type !== 'response_item'));
  await expect(discoverChat(root, root, 'thread')).rejects.toThrow('chat-human-message-required');
});
it('retains only the exact latest human source for an automatic continuation', async () => {
  const records: { type: string; payload: Record<string, unknown> }[] = native();
  const path = await source(records);
  const previous = (await discoverChat(root, root, 'thread')).human_source;
  records.push(
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'automatic' } },
    { type: 'turn_context', payload: { ...records[3]!.payload, turn_id: 'automatic' } },
  );
  for (const content of [
    null,
    [],
    [{ type: 'input_text', text: ' ' }],
    [{ type: 'input_text', text: '<skill>source' }],
    [{ type: 'image' }],
  ])
    records.push({ type: 'response_item', payload: { type: 'message', role: 'user', content } });
  await source(records);
  await expect(discoverChat(root, root, 'thread')).rejects.toThrow('chat-human-message-required');
  expect(
    await discoverChat(root, root, 'thread', { source: previous, turn_id: 'turn' }),
  ).toMatchObject({
    human_source: previous,
    previous_source_turn: 'turn',
    anchor: { turn_id: 'automatic' },
  });
  await expect(
    discoverChat(root, root, 'thread', {
      source: { ...previous, hash: '0'.repeat(64) },
      turn_id: 'turn',
    }),
  ).rejects.toThrow('chat-continuation-human-superseded');
  await expect(
    discoverChat(root, root, 'thread', { source: previous, turn_id: 'other' }),
  ).rejects.toThrow('chat-human-message-unconfirmed');
  records.push({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Новое поручение' }],
    },
  });
  await source(records);
  const fresh = await discoverChat(root, root, 'thread', { source: previous, turn_id: 'turn' });
  expect(fresh.previous_source_turn).toBeUndefined();
  expect(fresh.human_source.locator).not.toBe(previous.locator);
  const host = fresh.host;
  await expect(host.message(previous, 'turn')).rejects.toThrow(
    'chat-continuation-human-superseded',
  );
  await writeFile(
    path,
    (await readFile(path, 'utf8'))
      .replace('"role":"user"', '"role":"developer"')
      .replace('Новое поручение', '<external_codex_apps_open_page>{}'),
  );
  await expect(
    discoverChat(root, root, 'thread', { source: previous, turn_id: 'turn' }),
  ).rejects.toThrow('chat-continuation-human-superseded');
});
it('persists atomic private metadata and refuses a linked state file', async () => {
  const path = resolve(root, 'state.json');
  expect(readManaged(path)).toBeNull();
  saveManaged(path, { revision: 1 });
  saveManaged(path, { revision: 2 });
  expect(readManaged(path)).toEqual({ revision: 2 });
  await symlink(path, resolve(root, 'link.json'));
  expect(() => saveManaged(resolve(root, 'link.json'), {})).toThrow();
});
it('keeps the mandatory validation gate and explicit human gates', () => {
  expect(taskChatGates(['approval'], ['approval']).map((g) => [g.id, g.kind])).toEqual([
    ['approval', 'human'],
    ['validate', 'check'],
  ]);
  expect(() => taskChatGates(['criterion'], ['other'])).toThrow();
  expect(() => taskChatGates(['validate'], ['validate'])).toThrow();
  expect(
    taskChatOptions(['start', '--state', root, '--binary', '/bin/codex', '--human', 'approval'])
      .human,
  ).toEqual(['approval']);
});
it('reads the full ExecPlan format without a duplicate compact card', async () => {
  await writeFile(
    resolve(root, 'plan.md'),
    '# План\n\n## Результат и не-цели\n\nИзменить инструмент.\nБез публикации.\n\n## Критерии приёмки\n\n- [x] Проверка\n',
  );
  expect(await taskChatBrief(root, 'plan.md')).toEqual({
    outcome: 'Изменить инструмент.\nБез публикации.',
    scope: ['Изменить инструмент.\nБез публикации.'],
    criteria: ['Проверка'],
  });
});

it('keeps the same direct grant across a native date rollover and rejects a superseding message', async () => {
  const records = native();
  Object.assign(records[0]!.payload, {
    cli_version: '0.169.0-alpha.11.1',
    source: 'vscode',
    originator: 'codex_work_desktop',
    thread_source: 'user',
  });
  Object.assign(records[3]!.payload, { root_turn_id: 'turn' });
  Object.assign(records[2]!.payload, {
    internal_chat_message_metadata_passthrough: {
      turn_id: 'turn',
      content_item_kinds: ['user.text'],
      content_item_metadata: [{ provenance: { type: 'user' } }],
    },
  });
  const env = (date: string) => ({
    type: 'response_item',
    metadata: { client_authored: false },
    payload: {
      type: 'message',
      role: 'user',
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn',
        content_item_kinds: ['environments.environment_context'],
        content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
      },
      content: [
        {
          type: 'input_text',
          text: `<environment_context>\n  <current_date>${date}</current_date>\n  <timezone>Europe/Moscow</timezone>\n  <filesystem><root>${root}</root></filesystem>\n</environment_context>`,
        },
      ],
    },
  });
  const first = env('2026-11-19');
  const initial = {
    ...first,
    payload: {
      ...first.payload,
      content: [{ type: 'input_text', text: 'project rules' }, ...first.payload.content],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn',
        content_item_kinds: ['agents_md.instructions', 'environments.environment_context'],
        content_item_metadata: [
          { provenance: { type: 'agents_md' } },
          { provenance: { type: 'harness', hook: false } },
        ],
      },
    },
  };
  const refresh = env('2026-11-20');
  const raw = [records[0], records[1], initial, records[3], records[2], refresh];
  const file = await source(raw);
  const discover = () => discoverChat(root, root, 'thread', undefined, true);
  const grant = await discover();
  expect(grant.human_source.locator).toBe(file + '#L5');
  await expect(grant.host.message(grant.human_source, 'turn')).resolves.toMatchObject({
    turn_id: 'turn',
  });
  for (const mutate of [
    (r: typeof refresh) => {
      r.metadata.client_authored = true;
    },
    (r: typeof refresh) => {
      r.payload.internal_chat_message_metadata_passthrough.turn_id = 'another';
    },
    (r: typeof refresh) => {
      r.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ['user.text'];
    },
    (r: typeof refresh) => {
      r.payload.internal_chat_message_metadata_passthrough.content_item_metadata[0]!.provenance.hook = true;
    },
    (r: typeof refresh) => {
      r.payload.content.push({ type: 'input_text', text: 'STOP' });
    },
    (r: typeof refresh) => {
      r.payload.content[0]!.text += 'STOP';
    },
    (r: typeof refresh) => {
      r.payload.content[0]!.text = r.payload.content[0]!.text.replace(root, '/different');
    },
    (r: typeof refresh) => {
      r.payload.content[0]!.type = 'image';
    },
  ]) {
    const changed = structuredClone(refresh);
    mutate(changed);
    await source([...raw.slice(0, -1), changed]);
    await expect(discover()).rejects.toThrow();
  }
  await source([...raw, records[2]]);
  expect((await discover()).human_source.locator).toBe(file + '#L7');
});
